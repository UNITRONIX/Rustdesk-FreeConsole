/**
 * Cliprdr file clipboard sync for RdClient desktop (Explorer copy → remote paste).
 */
(function () {
    'use strict';

    var CLIP_POLL_MS = 1500;

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

    // eslint-disable-next-line no-unused-vars
    class RDCliprdr {
        static FILEDESCRIPTOR_FORMAT_ID = 49334;
        static FILECONTENTS_FORMAT_ID = 49267;

        static isSupported() {
            return isDesktopBridge();
        }

        static async initClient(client) {
            if (!RDCliprdr.isSupported() || !client) return;
            client._cliprdrPeerReady = false;
            client._cliprdrLocalSignature = '';
            client._cliprdrFormatNames = null;
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
                return;
            }
            if (client._state !== 'streaming' || client.viewOnly) {
                debugLog('syncPaths skipped: state=', client._state, 'viewOnly=', client.viewOnly);
                return;
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
                return;
            }

            debugLog('sync result:', sync, paths ? paths.length + ' path(s) supplied' : 'clipboard poll');

            if (!sync || !sync.hasFiles) {
                if (!paths) client._cliprdrLocalSignature = '';
                return;
            }

            var signature = sync.signature || '';
            if (signature && signature === client._cliprdrLocalSignature) {
                return;
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
            // The remote registers clipboard ownership asynchronously after
            // receiving FormatList, so give it a moment before synthesizing the
            // keystroke that triggers its native paste (and our FormatDataRequest
            // response).
            if (paths && paths.length && client.input && typeof client.input.sendCtrlV === 'function') {
                setTimeout(function () {
                    if (client._state !== 'streaming' || client.viewOnly) return;
                    debugLog('auto-paste: sending synthetic Ctrl+V after drop');
                    client.input.sendCtrlV();
                }, 400);
            }
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

            var formatDataReq = clipField(cliprdr, 'formatDataRequest', 'format_data_request');
            if (formatDataReq) {
                await RDCliprdr._respondFormatData(client, formatDataReq);
                return;
            }

            var fileContentsReq = clipField(cliprdr, 'fileContentsRequest', 'file_contents_request');
            if (fileContentsReq) {
                await RDCliprdr._respondFileContents(client, fileContentsReq);
            }
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
                client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(0x2, new Uint8Array(0)));
                return;
            }

            try {
                const data = await desktopInvoke('desktop_clipboard_format_data');
                const bytes = toUint8Array(data);
                if (!bytes.length) {
                    client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(0x2, new Uint8Array(0)));
                    return;
                }
                debugLog('FormatDataResponse', bytes.length, 'bytes');
                client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(0x1, bytes));
            } catch (err) {
                console.warn('[RDCliprdr] format data failed:', err);
                client._sendPeerMessage(client.proto.buildCliprdrFormatDataResponse(0x2, new Uint8Array(0)));
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
                client._sendPeerMessage(client.proto.buildCliprdrFileContentsResponse(0x1, streamId, bytes));
            } catch (err) {
                console.warn('[RDCliprdr] file contents failed:', err);
                client._sendPeerMessage(client.proto.buildCliprdrFileContentsResponse(0x2, streamId, new Uint8Array(0)));
            }
        }

        static clearLocalCache() {
            if (!RDCliprdr.isSupported()) return Promise.resolve();
            return desktopInvoke('desktop_clipboard_clear').catch(function () { /* ignore */ });
        }
    }

    window.RDCliprdr = RDCliprdr;
})();
