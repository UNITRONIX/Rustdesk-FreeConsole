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
            client._cliprdrDragOutConverting = false;
            client._cliprdrOleDragIntent = false;
            if (client._cliprdrDragOutTimer) {
                clearTimeout(client._cliprdrDragOutTimer);
                client._cliprdrDragOutTimer = null;
            }
            try {
                client._cliprdrFormatNames = await desktopInvoke('desktop_clipboard_format_names');
            } catch (_) {
                client._cliprdrFormatNames = null;
            }
            client._sendPeerMessage(client.proto.buildCliprdrMonitorReady());
            RDCliprdr.startPolling(client);

            // Remote Explorer drag never updates Cliprdr by itself — when the
            // operator drags toward the window edge we Ctrl+C on the remote so
            // FormatList arrives and we can start a local OLE drag-out.
            if (client.input) {
                client.input.onPotentialFileDragOut = function () {
                    RDCliprdr._beginDragOutConversion(client);
                };
            }
        }

        /**
         * Convert a stuck remote Explorer file-drag into Cliprdr + local OLE drag.
         * RustDesk only advertises files via clipboard FormatList (Copy), not OLE.
         */
        static _beginDragOutConversion(client) {
            if (!RDCliprdr.isSupported() || !client) return;
            if (client._state !== 'streaming' || client.viewOnly) return;
            if (client._cliprdrDragOutConverting || client._cliprdrReceiving) return;
            if (client._cliprdrOleDragStarting) return;

            client._cliprdrDragOutConverting = true;
            client._cliprdrOleDragIntent = true;
            client._cliprdrOleDragWhenReady = true;

            if (client.input && typeof client.input.setMouseSuppressed === 'function') {
                client.input.setMouseSuppressed(true);
            }
            try {
                void desktopInvoke('desktop_clipboard_prepare_ole_drag');
            } catch (_) { /* ignore */ }

            console.info('[RDCliprdr] remote Explorer drag → Ctrl+C for local drop; keep mouse button held');

            if (client._cliprdrDragOutTimer) {
                clearTimeout(client._cliprdrDragOutTimer);
            }
            // Let remote finish cancelling its OLE drag before Copy.
            setTimeout(function () {
                if (!client._cliprdrDragOutConverting) return;
                if (client.input && typeof client.input.sendCtrlC === 'function') {
                    client.input.sendCtrlC();
                }
            }, 60);

            client._cliprdrDragOutTimer = setTimeout(function () {
                client._cliprdrDragOutTimer = null;
                if (!client._cliprdrDragOutConverting) return;
                if (client._cliprdrReceiving || client._cliprdrOleDragStarting) return;
                client._cliprdrDragOutConverting = false;
                client._cliprdrOleDragIntent = false;
                client._cliprdrOleDragWhenReady = false;
                RDCliprdr._disarmOleDrag(client);
                if (client.input && typeof client.input.setMouseSuppressed === 'function') {
                    client.input.setMouseSuppressed(false);
                }
                console.warn('[RDCliprdr] no file clipboard after drag-out conversion — use Copy/Paste or File transfer');
            }, 4000);
        }

        static _clearDragOutConversion(client, restoreMouse) {
            if (!client) return;
            client._cliprdrDragOutConverting = false;
            if (client._cliprdrDragOutTimer) {
                clearTimeout(client._cliprdrDragOutTimer);
                client._cliprdrDragOutTimer = null;
            }
            if (restoreMouse && client.input && typeof client.input.setMouseSuppressed === 'function') {
                client.input.setMouseSuppressed(false);
            }
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
            return RDCliprdr.syncPaths(client, null, null);
        }

        /**
         * @param {Object} client
         * @param {string[]|null} paths
         * @param {{x?: number, y?: number}|null} [position] - physical drop position (webview)
         */
        static async syncPaths(client, paths, position) {
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
            // DnD paths must always re-advertise + auto-paste even if signature matches
            // a prior clipboard copy of the same files.
            var forceAdvertise = !!(paths && paths.length);
            if (!forceAdvertise && signature && signature === client._cliprdrLocalSignature) {
                return sync;
            }
            client._cliprdrLocalSignature = signature;
            debugLog('FormatList', paths ? paths.length + ' path(s)' : 'clipboard');
            if (client._cliprdrFormatNames == null) {
                client._cliprdrFormatNames = await desktopInvoke('desktop_clipboard_format_names').catch(function () { return null; });
            }

            var formatListAck = null;
            if (forceAdvertise) {
                formatListAck = RDCliprdr._waitFormatListAck(client, 2500);
            }
            client._sendPeerMessage(client.proto.buildCliprdrFormatList(
                client._cliprdrFormatNames || undefined
            ));

            // Explicit paths = OS drag-drop onto the viewer — focus the drop
            // point on the remote, wait briefly for FormatList ack, then Ctrl+V.
            if (forceAdvertise && client.input) {
                RDCliprdr._autoPasteAfterDrop(client, position, formatListAck);
            }
            return sync;
        }

        static _waitFormatListAck(client, timeoutMs) {
            return new Promise(function (resolve) {
                var settled = false;
                var timer = setTimeout(function () {
                    if (settled) return;
                    settled = true;
                    if (client._cliprdrFormatListAckResolve === resolve) {
                        client._cliprdrFormatListAckResolve = null;
                    }
                    resolve(false);
                }, timeoutMs || 2500);
                client._cliprdrFormatListAckResolve = function () {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    client._cliprdrFormatListAckResolve = null;
                    resolve(true);
                };
            });
        }

        static _autoPasteAfterDrop(client, position, formatListAck) {
            void (async function () {
                try {
                    if (formatListAck) await formatListAck;
                    else await new Promise(function (r) { setTimeout(r, 400); });
                    if (client._state !== 'streaming' || client.viewOnly) return;

                    if (position && typeof client.input.clickAtCanvas === 'function') {
                        var mapped = RDCliprdr._mapDropPositionToCanvas(client, position);
                        if (mapped) {
                            debugLog('auto-paste: click at canvas', mapped.x, mapped.y);
                            client.input.clickAtCanvas(mapped.x, mapped.y);
                            await new Promise(function (r) { setTimeout(r, 80); });
                        }
                    }
                    if (typeof client.input.sendCtrlV === 'function') {
                        debugLog('auto-paste: sending synthetic Ctrl+V after drop');
                        client.input.sendCtrlV();
                    }
                } catch (err) {
                    console.warn('[RDCliprdr] auto-paste after drop failed:', err);
                }
            })();
        }

        static _mapDropPositionToCanvas(client, position) {
            if (!position || !client || !client.input || !client.input.canvas) return null;
            var canvas = client.input.canvas;
            var dpr = window.devicePixelRatio || 1;
            var x = Number(position.x);
            var y = Number(position.y);
            if (!isFinite(x) || !isFinite(y)) return null;
            // Tauri/wry positions are physical pixels relative to the webview client area.
            var cssX = x / dpr;
            var cssY = y / dpr;
            var rect = canvas.getBoundingClientRect();
            return {
                x: cssX - rect.left,
                y: cssY - rect.top
            };
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
                if (typeof client._cliprdrFormatListAckResolve === 'function') {
                    client._cliprdrFormatListAckResolve();
                }
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
                if (client._cliprdrDragOutConverting) {
                    RDCliprdr._clearDragOutConversion(client, true);
                    client._cliprdrOleDragIntent = false;
                    client._cliprdrOleDragWhenReady = false;
                }
                return;
            }

            client._cliprdrPeerFdId = fdId;
            client._cliprdrPeerFcId = fcId;
            client._sendPeerMessage(client.proto.buildCliprdrFormatListResponse(CB_RESPONSE_OK));

            // Drag-out: either we just converted Explorer-drag→Ctrl+C, or FormatList
            // arrived while local LBUTTON is still down.
            var dragIntent = !!client._cliprdrDragOutConverting;
            if (!dragIntent) {
                try {
                    dragIntent = !!(await desktopInvoke('desktop_clipboard_lbutton_down'));
                } catch (_) {
                    dragIntent = false;
                }
            }
            RDCliprdr._clearDragOutConversion(client, false);
            client._cliprdrOleDragIntent = dragIntent;
            client._cliprdrOleDragWhenReady = false;
            RDCliprdr._disarmOleDrag(client);

            try {
                client._cliprdrReceiving = true;
                suppressOutbound(client, OUTBOUND_SUPPRESS_MS);
                if (dragIntent) {
                    if (client.input && typeof client.input.setMouseSuppressed === 'function') {
                        client.input.setMouseSuppressed(true);
                    }
                    try {
                        await desktopInvoke('desktop_clipboard_prepare_ole_drag');
                    } catch (prepErr) {
                        debugLog('prepare OLE drag:', prepErr);
                    }
                    console.info('[RDCliprdr] remote→local drag: downloading; keep mouse button held');
                    RDCliprdr._armOleDragOnLeave(client);
                }
                await RDCliprdr._pullRemoteFiles(client, fdId);
            } catch (err) {
                console.warn('[RDCliprdr] inbound file pull failed:', err);
                try { await desktopInvoke('desktop_clipboard_receive_abort'); } catch (_) { /* ignore */ }
                RDCliprdr._disarmOleDrag(client);
                client._cliprdrOleDragIntent = false;
                if (client.input && typeof client.input.setMouseSuppressed === 'function') {
                    client.input.setMouseSuppressed(false);
                }
            } finally {
                client._cliprdrReceiving = false;
                suppressOutbound(client, OUTBOUND_SUPPRESS_MS);
            }
        }

        static _disarmOleDrag(client) {
            if (!client) return;
            if (client._cliprdrOleDragLeaveHandler) {
                document.removeEventListener('mouseleave', client._cliprdrOleDragLeaveHandler, true);
                document.documentElement.removeEventListener('pointerleave', client._cliprdrOleDragLeaveHandler, true);
                window.removeEventListener('blur', client._cliprdrOleDragLeaveHandler);
                client._cliprdrOleDragLeaveHandler = null;
            }
        }

        static _armOleDragOnLeave(client) {
            RDCliprdr._disarmOleDrag(client);
            var handler = function () {
                if (!client._cliprdrOleDragIntent) return;
                if (client._cliprdrOleDragPaths && client._cliprdrOleDragPaths.length) {
                    RDCliprdr._startOleDrag(client, client._cliprdrOleDragPaths);
                } else {
                    // Files still downloading — start drag as soon as commit finishes.
                    client._cliprdrOleDragWhenReady = true;
                }
            };
            client._cliprdrOleDragLeaveHandler = handler;
            document.addEventListener('mouseleave', handler, true);
            document.documentElement.addEventListener('pointerleave', handler, true);
            window.addEventListener('blur', handler);
        }

        static async _startOleDrag(client, paths) {
            if (!paths || !paths.length) return;
            if (!client._cliprdrOleDragIntent && !client._cliprdrOleDragWhenReady) return;
            if (client._cliprdrOleDragStarting) return;
            client._cliprdrOleDragStarting = true;
            client._cliprdrOleDragIntent = false;
            client._cliprdrOleDragWhenReady = false;
            RDCliprdr._disarmOleDrag(client);
            try {
                var stillDown = await desktopInvoke('desktop_clipboard_lbutton_down');
                if (!stillDown) {
                    debugLog('OLE drag skipped: LBUTTON up');
                    return;
                }
                // Stop forwarding mouse to remote so the cursor can leave the window.
                if (client.input && typeof client.input.setMouseSuppressed === 'function') {
                    client.input.setMouseSuppressed(true);
                }
                console.info('[RDCliprdr] starting OLE drag-out with', paths.length, 'path(s)');
                var result = await desktopInvoke('desktop_clipboard_start_drag', { paths: paths });
                debugLog('OLE drag result:', result);
            } catch (err) {
                console.warn('[RDCliprdr] OLE drag-out failed:', err);
            } finally {
                client._cliprdrOleDragStarting = false;
                if (client.input && typeof client.input.setMouseSuppressed === 'function') {
                    client.input.setMouseSuppressed(false);
                }
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
            var paths = (commit && commit.paths) || [];
            client._cliprdrOleDragPaths = paths;
            debugLog('inbound receive committed; local CF_HDROP ready', paths.length, 'top path(s)');

            // Start OLE drag immediately while LBUTTON is still down — do not wait
            // for mouseleave. The remote/WebView often traps the cursor at the
            // window edge, so leave never fires and drag-out used to hang.
            if (paths.length && (client._cliprdrOleDragIntent || client._cliprdrOleDragWhenReady)) {
                await RDCliprdr._startOleDrag(client, paths);
            } else if (client._cliprdrOleDragIntent) {
                // Download finished but nothing to drag — restore local mouse.
                client._cliprdrOleDragIntent = false;
                RDCliprdr._disarmOleDrag(client);
                if (client.input && typeof client.input.setMouseSuppressed === 'function') {
                    client.input.setMouseSuppressed(false);
                }
            }
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
