/**
 * Cliprdr file clipboard sync for RdClient desktop (local ↔ remote Explorer paste).
 *
 * Outbound: CF_HDROP → FormatList → serve FormatData/FileContents.
 * Inbound: peer FormatList → request descriptor + file bytes → local CF_HDROP.
 */
(function () {
    'use strict';

    var CLIP_POLL_MS = 1500;
    var INBOUND_CHUNK = 65536;
    var OUTBOUND_SUPPRESS_MS = 4000;
    var CB_RESPONSE_OK = 0x1;
    var CB_RESPONSE_FAIL = 0x2;
    var FILECONTENTS_SIZE = 0x1;
    var FILECONTENTS_RANGE = 0x2;

    function isDesktopBridge() {
        return window.__BETTERDESK_RDCLIENT_DESKTOP__ === true
            && window.__TAURI__
            && window.__TAURI__.core
            && typeof window.__TAURI__.core.invoke === 'function';
    }

    function desktopInvoke(cmd, args) {
        return window.__TAURI__.core.invoke(cmd, args || {});
    }

    function toUint8Array(data) {
        if (!data) return new Uint8Array(0);
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (Array.isArray(data)) return new Uint8Array(data);
        return new Uint8Array(0);
    }

    function clipField(cliprdr, camel, snake) {
        if (!cliprdr) return null;
        if (cliprdr[camel] != null) return cliprdr[camel];
        if (snake && cliprdr[snake] != null) return cliprdr[snake];
        return null;
    }

    function debugLog() {
        if (typeof window !== 'undefined' && window.BetterDesk && window.BetterDesk.debugRelay) {
            console.log.apply(console, ['[RDCliprdr]'].concat(Array.prototype.slice.call(arguments)));
        }
    }

    function formatNameEquals(name, expected) {
        if (!name) return false;
        return String(name).toLowerCase() === String(expected).toLowerCase();
    }

    function nextStreamId(client) {
        var next = (client._cliprdrStreamId || 0) + 1;
        client._cliprdrStreamId = next;
        return next;
    }

    function pendingKey(streamId) {
        return String(streamId);
    }

    function waitForPeerResponse(client, streamId, timeoutMs) {
        if (!client._cliprdrPending) client._cliprdrPending = Object.create(null);
        var key = pendingKey(streamId);
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                delete client._cliprdrPending[key];
                reject(new Error('Cliprdr response timeout (stream ' + streamId + ')'));
            }, timeoutMs || 60000);
            client._cliprdrPending[key] = {
                resolve: function (bytes) {
                    clearTimeout(timer);
                    resolve(bytes);
                },
                reject: function (err) {
                    clearTimeout(timer);
                    reject(err);
                }
            };
        });
    }

    function resolvePending(client, streamId, ok, bytes) {
        if (!client._cliprdrPending) return;
        var pending = client._cliprdrPending[pendingKey(streamId)];
        if (!pending) return;
        delete client._cliprdrPending[pendingKey(streamId)];
        if (ok) pending.resolve(bytes || new Uint8Array(0));
        else pending.reject(new Error('peer reported Cliprdr failure'));
    }

    function suppressOutbound(client, ms) {
        client._cliprdrSuppressOutboundUntil = Date.now() + (ms || OUTBOUND_SUPPRESS_MS);
    }

    function outboundSuppressed(client) {
        return client._cliprdrReceiving
            || (client._cliprdrSuppressOutboundUntil && Date.now() < client._cliprdrSuppressOutboundUntil);
    }

    // eslint-disable-next-line no-unused-vars
    class RDCliprdr {
        static FILEDESCRIPTOR_FORMAT_ID = 49334;
        static FILECONTENTS_FORMAT_ID = 49267;
        static FILEDESCRIPTOR_FORMAT_NAME = 'FileGroupDescriptorW';
        static FILECONTENTS_FORMAT_NAME = 'FileContents';

        static isSupported() {
            return isDesktopBridge();
        }

        static async initClient(client) {
            if (!RDCliprdr.isSupported() || !client) return;
            client._cliprdrPeerReady = false;
            client._cliprdrLocalSignature = '';
            client._cliprdrFormatNames = null;
            client._cliprdrStreamId = 1;
            client._cliprdrPending = Object.create(null);
            client._cliprdrReceiving = false;
            client._cliprdrSuppressOutboundUntil = 0;
            client._cliprdrPeerFdId = RDCliprdr.FILEDESCRIPTOR_FORMAT_ID;
            client._cliprdrPeerFcId = RDCliprdr.FILECONTENTS_FORMAT_ID;
            try {
                client._cliprdrFormatNames = await desktopInvoke('desktop_clipboard_format_names');
            } catch (_) {
                client._cliprdrFormatNames = null;
            }
            client._sendPeerMessage(client.proto.buildCliprdrMonitorReady());
            RDCliprdr.startPolling(client);
        }

        static stopPolling(client) {
            if (!client || !client._cliprdrPollTimer) return;
            clearInterval(client._cliprdrPollTimer);
            client._cliprdrPollTimer = null;
        }

        static startPolling(client) {
            if (!RDCliprdr.isSupported() || !client) return;
            RDCliprdr.stopPolling(client);
            client._cliprdrPollTimer = setInterval(function () {
                if (client._state !== 'streaming' || client.viewOnly) return;
                void RDCliprdr.syncLocalFiles(client);
            }, CLIP_POLL_MS);
        }

        static async syncLocalFiles(client) {
            return RDCliprdr.syncPaths(client, null);
        }

        static async syncPaths(client, paths) {
            if (!RDCliprdr.isSupported() || !client) {
                debugLog('syncPaths skipped: isSupported=', RDCliprdr.isSupported(), 'client=', !!client);
                return { hasFiles: false, signature: '', busy: false };
            }
            if (client._state !== 'streaming' || client.viewOnly) {
                debugLog('syncPaths skipped: state=', client._state, 'viewOnly=', client.viewOnly);
                return { hasFiles: false, signature: '', busy: false };
            }
            if (!paths && outboundSuppressed(client)) {
                debugLog('syncPaths skipped: outbound suppressed (inbound receive)');
                return { hasFiles: false, signature: client._cliprdrLocalSignature || '', busy: false };
            }

            var sync;
            try {
                if (paths && paths.length) {
                    sync = await desktopInvoke('desktop_clipboard_sync_paths', { paths: paths });
                } else {
                    sync = await desktopInvoke('desktop_clipboard_sync');
                }
            } catch (err) {
                console.warn('[RDCliprdr] sync failed:', err);
                return { hasFiles: false, signature: '', busy: false };
            }

            debugLog('sync result:', sync, paths ? paths.length + ' path(s) supplied' : 'clipboard poll');

            if (sync && sync.busy) {
                return sync;
            }

            if (!sync || !sync.hasFiles) {
                if (!paths) client._cliprdrLocalSignature = '';
                return sync || { hasFiles: false, signature: '', busy: false };
            }

            var signature = sync.signature || '';
            if (signature && signature === client._cliprdrLocalSignature) {
                return sync;
            }
            client._cliprdrLocalSignature = signature;
            debugLog('FormatList', paths ? paths.length + ' path(s)' : 'clipboard');
            if (client._cliprdrFormatNames == null) {
                client._cliprdrFormatNames = await desktopInvoke('desktop_clipboard_format_names').catch(function () { return null; });
            }
            client._sendPeerMessage(client.proto.buildCliprdrFormatList(
                client._cliprdrFormatNames || undefined
            ));

            // Explicit paths means this came from a real OS drag-drop onto the
            // viewer (not the periodic clipboard poll) — auto-complete the paste
            // on the remote so the operator doesn't have to press Ctrl+V manually.
            if (paths && paths.length && client.input && typeof client.input.sendCtrlV === 'function') {
                setTimeout(function () {
                    if (client._state !== 'streaming' || client.viewOnly) return;
                    debugLog('auto-paste: sending synthetic Ctrl+V after drop');
                    client.input.sendCtrlV();
                }, 400);
            }
            return sync;
        }

        static async handleMessage(client, cliprdr) {
            if (!cliprdr || !client) return;

            if (clipField(cliprdr, 'ready', null)) {
                client._cliprdrPeerReady = true;
                client._sendPeerMessage(client.proto.buildCliprdrMonitorReady());
                await RDCliprdr.syncLocalFiles(client);
                return;
            }

            if (clipField(cliprdr, 'formatListResponse', 'format_list_response')) {
                return;
            }

            var formatList = clipField(cliprdr, 'formatList', 'format_list');
            if (formatList) {
                await RDCliprdr._handleInboundFormatList(client, formatList);
                return;
            }

            var formatDataReq = clipField(cliprdr, 'formatDataRequest', 'format_data_request');
            if (formatDataReq) {
                await RDCliprdr._respondFormatData(client, formatDataReq);
                return;
            }

            var formatDataResp = clipField(cliprdr, 'formatDataResponse', 'format_data_response');
            if (formatDataResp) {
                RDCliprdr._handleFormatDataResponse(client, formatDataResp);
                return;
            }

            var fileContentsReq = clipField(cliprdr, 'fileContentsRequest', 'file_contents_request');
            if (fileContentsReq) {
                await RDCliprdr._respondFileContents(client, fileContentsReq);
                return;
            }

            var fileContentsResp = clipField(cliprdr, 'fileContentsResponse', 'file_contents_response');
            if (fileContentsResp) {
                RDCliprdr._handleFileContentsResponse(client, fileContentsResp);
            }
        }

        static _handleFormatDataResponse(client, resp) {
            var flags = Number(resp.msgFlags != null ? resp.msgFlags : resp.msg_flags || 0);
            var data = toUint8Array(resp.formatData != null ? resp.formatData : resp.format_data);
            // FormatDataResponse has no stream id — use the reserved pending key.
            resolvePending(client, client._cliprdrFormatDataStreamId || 0, flags === CB_RESPONSE_OK, data);
        }

        static _handleFileContentsResponse(client, resp) {
            var flags = Number(resp.msgFlags != null ? resp.msgFlags : resp.msg_flags || 0);
            var streamId = Number(resp.streamId != null ? resp.streamId : resp.stream_id || 0);
            var data = toUint8Array(resp.requestedData != null ? resp.requestedData : resp.requested_data);
            resolvePending(client, streamId, flags === CB_RESPONSE_OK, data);
        }

        static async _handleInboundFormatList(client, formatList) {
            if (client._state !== 'streaming' || client.viewOnly) return;
            if (client._cliprdrReceiving) {
                debugLog('inbound FormatList ignored: already receiving');
                return;
            }

            var formats = formatList.formats || [];
            var fdId = null;
            var fcId = null;
            for (var i = 0; i < formats.length; i++) {
                var fmt = formats[i] || {};
                var id = Number(fmt.id);
                var name = fmt.format || '';
                if (formatNameEquals(name, RDCliprdr.FILEDESCRIPTOR_FORMAT_NAME)
                    || id === RDCliprdr.FILEDESCRIPTOR_FORMAT_ID) {
                    fdId = id;
                }
                if (formatNameEquals(name, RDCliprdr.FILECONTENTS_FORMAT_NAME)
                    || id === RDCliprdr.FILECONTENTS_FORMAT_ID) {
                    fcId = id;
                }
            }
            if (fdId == null || fcId == null) {
                debugLog('inbound FormatList has no file formats');
                return;
            }

            client._cliprdrPeerFdId = fdId;
            client._cliprdrPeerFcId = fcId;
            client._sendPeerMessage(client.proto.buildCliprdrFormatListResponse(CB_RESPONSE_OK));

            try {
                client._cliprdrReceiving = true;
                suppressOutbound(client, OUTBOUND_SUPPRESS_MS);
                await RDCliprdr._pullRemoteFiles(client, fdId);
            } catch (err) {
                console.warn('[RDCliprdr] inbound file pull failed:', err);
                try { await desktopInvoke('desktop_clipboard_receive_abort'); } catch (_) { /* ignore */ }
            } finally {
                client._cliprdrReceiving = false;
                suppressOutbound(client, OUTBOUND_SUPPRESS_MS);
            }
        }

        static async _pullRemoteFiles(client, fdId) {
            var formatStreamId = 0;
            client._cliprdrFormatDataStreamId = formatStreamId;
            var formatWait = waitForPeerResponse(client, formatStreamId, 30000);
            client._sendPeerMessage(client.proto.buildCliprdrFormatDataRequest(fdId));
            var pdu = await formatWait;
            if (!pdu || !pdu.length) {
                throw new Error('empty FormatDataResponse');
            }

            var begin = await desktopInvoke('desktop_clipboard_receive_begin', {
                formatData: Array.from(pdu)
            });
            var files = (begin && begin.files) || [];
            debugLog('inbound receive begin:', files.length, 'entries');

            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                if (file.isDir || file.is_dir) continue;
                var listIndex = Number(file.index);
                var expectedSize = Number(file.size || 0);

                // Prefer descriptor size; fall back to FILECONTENTS_SIZE probe.
                var size = expectedSize;
                if (!size) {
                    size = await RDCliprdr._requestFileSize(client, listIndex);
                }
                if (!size) {
                    debugLog('skip empty file index', listIndex);
                    continue;
                }

                var offset = 0;
                while (offset < size) {
                    var chunkLen = Math.min(INBOUND_CHUNK, size - offset);
                    var chunk = await RDCliprdr._requestFileRange(client, listIndex, offset, chunkLen);
                    if (!chunk || !chunk.length) {
                        throw new Error('empty FileContents chunk at offset ' + offset);
                    }
                    await desktopInvoke('desktop_clipboard_receive_write', {
                        listIndex: listIndex,
                        offset: offset,
                        data: Array.from(chunk)
                    });
                    offset += chunk.length;
                    if (chunk.length < chunkLen) break;
                }
            }

            var commit = await desktopInvoke('desktop_clipboard_receive_commit');
            if (commit && commit.signature) {
                client._cliprdrLocalSignature = commit.signature;
            }
            debugLog('inbound receive committed; local CF_HDROP ready');
        }

        static async _requestFileSize(client, listIndex) {
            var streamId = nextStreamId(client);
            var wait = waitForPeerResponse(client, streamId, 30000);
            client._sendPeerMessage(client.proto.buildCliprdrFileContentsRequest({
                streamId: streamId,
                listIndex: listIndex,
                dwFlags: FILECONTENTS_SIZE,
                nPositionLow: 0,
                nPositionHigh: 0,
                cbRequested: 8
            }));
            var data = await wait;
            if (!data || data.length < 8) return 0;
            var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            // RustDesk / our outbound encode size as u64 LE (not two u32s with high first).
            var lo = view.getUint32(0, true);
            var hi = view.getUint32(4, true);
            return hi * 0x100000000 + lo;
        }

        static async _requestFileRange(client, listIndex, offset, length) {
            var streamId = nextStreamId(client);
            var wait = waitForPeerResponse(client, streamId, 60000);
            var nPositionLow = offset >>> 0;
            var nPositionHigh = Math.floor(offset / 0x100000000) >>> 0;
            client._sendPeerMessage(client.proto.buildCliprdrFileContentsRequest({
                streamId: streamId,
                listIndex: listIndex,
                dwFlags: FILECONTENTS_RANGE,
                nPositionLow: nPositionLow,
                nPositionHigh: nPositionHigh,
                cbRequested: length
            }));
            return wait;
        }

        static async _respondFormatData(client, req) {
            var formatId = Number(req.requestedFormatId != null
                ? req.requestedFormatId
                : req.requested_format_id);
            var fdId = client._cliprdrFormatNames
                ? Number(client._cliprdrFormatNames.fileDescriptorFormatId
                    || client._cliprdrFormatNames.file_descriptor_format_id
                    || RDCliprdr.FILEDESCRIPTOR_FORMAT_ID)
                : RDCliprdr.FILEDESCRIPTOR_FORMAT_ID;

            if (formatId !== fdId) {
                client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(CB_RESPONSE_FAIL, new Uint8Array(0)));
                return;
            }

            try {
                const data = await desktopInvoke('desktop_clipboard_format_data');
                const bytes = toUint8Array(data);
                if (!bytes.length) {
                    client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(CB_RESPONSE_FAIL, new Uint8Array(0)));
                    return;
                }
                debugLog('FormatDataResponse', bytes.length, 'bytes');
                client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(CB_RESPONSE_OK, bytes));
            } catch (err) {
                console.warn('[RDCliprdr] format data failed:', err);
                client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(CB_RESPONSE_FAIL, new Uint8Array(0)));
            }
        }

        static async _respondFileContents(client, req) {
            var streamId = Number(req.streamId != null ? req.streamId : req.stream_id || 0);
            var listIndex = Number(req.listIndex != null ? req.listIndex : req.list_index || 0);
            var dwFlags = Number(req.dwFlags != null ? req.dwFlags : req.dw_flags || 0);
            var nPositionLow = Number(req.nPositionLow != null ? req.nPositionLow : req.n_position_low || 0);
            var nPositionHigh = Number(req.nPositionHigh != null ? req.nPositionHigh : req.n_position_high || 0);
            var cbRequested = Number(req.cbRequested != null ? req.cbRequested : req.cb_requested || 0);

            try {
                var data = await desktopInvoke('desktop_clipboard_file_contents', {
                    listIndex: listIndex,
                    dwFlags: dwFlags,
                    nPositionLow: nPositionLow,
                    nPositionHigh: nPositionHigh,
                    cbRequested: cbRequested
                });
                var bytes = toUint8Array(data);
                client._sendPeerMessage(client.proto.buildCliprdrFileContentsResponse(CB_RESPONSE_OK, streamId, bytes));
            } catch (err) {
                console.warn('[RDCliprdr] file contents failed:', err);
                client._sendPeerMessage(client.proto.buildCliprdrFileContentsResponse(CB_RESPONSE_FAIL, streamId, new Uint8Array(0)));
            }
        }

        static clearLocalCache() {
            if (!RDCliprdr.isSupported()) return Promise.resolve();
            return desktopInvoke('desktop_clipboard_clear').catch(function () { /* ignore */ });
        }
    }

    window.RDCliprdr = RDCliprdr;
})();
