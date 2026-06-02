/*
 * WASM_OS worker glue for TinyEMU (emscripten --js-library).
 *
 * Replaces upstream js/lib.js, which targets the jslinux HTML page (globals
 * `term`, `graphic_display`, `Browser`, `Runtime`, `document`). This version runs
 * inside the emulator Web Worker with no DOM: every C import is satisfied here and
 * delegates to hooks the worker installs on `globalThis.__wasmosEmu`
 * (see packages/host/src/worker/emulator-worker.ts):
 *
 *   __wasmosEmu.serial(Uint8Array)        - guest console (hvc0) output bytes
 *   __wasmosEmu.consoleSize() -> [w,h]    - reported terminal size
 *   __wasmosEmu.fb(buf,x,y,w,h,stride)    - framebuffer refresh (RGBA in wasm heap)
 *   __wasmosEmu.downloading(bool)         - VM file download in-flight indicator
 *
 * It is MIT — same terms as the rest of TinyEMU (it is a port of the MIT js/lib.js).
 * Modernized for emscripten 5.0.7: UTF8ToString (not Pointer_stringify), makeDynCall
 * (not Runtime.dynCall), and a self-contained wget/file-buffer table (not Browser.*).
 */
mergeInto(LibraryManager.library, {
  // --- guest console (hvc0) ------------------------------------------------
  console_write: function (opaque, buf, len) {
    // Raw guest bytes; the host terminal decodes UTF-8.
    globalThis.__wasmosEmu.serial(HEAPU8.subarray(buf, buf + len));
  },

  console_get_size: function (pw, ph) {
    var r = globalThis.__wasmosEmu.consoleSize();
    HEAPU32[pw >> 2] = r[0];
    HEAPU32[ph >> 2] = r[1];
  },

  // Browser file-download export — unused headless; swallow it.
  fs_export_file: function (filename, buf, buf_len) {},

  // --- async HTTP loader (VM config / bios / kernel / block-device ranges) --
  // The VM files are served same-origin; XMLHttpRequest works in a worker.
  emscripten_async_wget3_data__deps: ['$wasmosWget', 'malloc', 'free'],
  emscripten_async_wget3_data: function (url, request, user, password, post_data, post_data_len, arg, free, onload, onerror, onprogress) {
    var _url = UTF8ToString(url);
    var _request = UTF8ToString(request);
    var http = new XMLHttpRequest();
    http.open(_request, _url, true);
    http.responseType = 'arraybuffer';
    if (user) {
      http.setRequestHeader('Authorization', 'Basic ' + btoa(UTF8ToString(user) + ':' + (password ? UTF8ToString(password) : '')));
    }
    var handle = wasmosWget.nextHandle++;
    http.onload = function () {
      var success = http.status === 200 || http.status === 206 || (http.status === 0 && _url.substr(0, 4).toLowerCase() !== 'http');
      if (success) {
        var bytes = new Uint8Array(http.response);
        var buffer = _malloc(bytes.length);
        HEAPU8.set(bytes, buffer);
        if (onload) {{{ makeDynCall('viiii', 'onload') }}}(handle, arg, buffer, bytes.length);
        if (free) _free(buffer);
      } else if (onerror) {
        {{{ makeDynCall('viiii', 'onerror') }}}(handle, arg, http.status, 0);
      }
      delete wasmosWget.reqs[handle];
    };
    http.onerror = function () {
      if (onerror) {{{ makeDynCall('viiii', 'onerror') }}}(handle, arg, http.status, 0);
      delete wasmosWget.reqs[handle];
    };
    http.onprogress = function (e) {
      if (onprogress) {{{ makeDynCall('viiii', 'onprogress') }}}(handle, arg, e.loaded, e.lengthComputable ? e.total : 0);
    };
    if (_request === 'POST') {
      http.setRequestHeader('Content-type', 'application/octet-stream');
      http.send(HEAPU8.subarray(post_data, post_data + post_data_len));
    } else {
      http.send(null);
    }
    wasmosWget.reqs[handle] = http;
    return handle;
  },

  fs_wget_update_downloading: function (flag) {
    var h = globalThis.__wasmosEmu;
    if (h.downloading) h.downloading(Boolean(flag));
  },

  // --- framebuffer (graphics mode) -----------------------------------------
  fb_refresh: function (opaque, data, x, y, w, h, stride) {
    globalThis.__wasmosEmu.fb(data, x, y, w, h, stride);
  },

  // --- networking (disabled: no eth0 in the VM config) ---------------------
  net_recv_packet: function (bs, buf, buf_len) {},

  // --- wget request handle table -------------------------------------------
  $wasmosWget: { nextHandle: 1, reqs: {} },

  // --- file buffer API (block-device HTTP cache, block_net.c) --------------
  $wasmosFbuf: { table: {}, next: 1 },
  file_buffer_get_new_handle__deps: ['$wasmosFbuf'],
  file_buffer_get_new_handle: function () {
    var h = wasmosFbuf.next++;
    if (wasmosFbuf.next >= 0x80000000) wasmosFbuf.next = 1;
    return h;
  },
  file_buffer_init__deps: ['$wasmosFbuf'],
  file_buffer_init: function (bs) {
    HEAPU32[bs >> 2] = 0;
    HEAPU32[(bs + 4) >> 2] = 0;
  },
  file_buffer_resize__deps: ['file_buffer_get_new_handle', '$wasmosFbuf'],
  file_buffer_resize: function (bs, new_size) {
    var h = HEAPU32[bs >> 2];
    var size = HEAPU32[(bs + 4) >> 2];
    if (new_size === 0) {
      if (h !== 0) { delete wasmosFbuf.table[h]; h = 0; }
    } else if (size === 0) {
      h = _file_buffer_get_new_handle();
      wasmosFbuf.table[h] = new Uint8Array(new_size);
    } else if (size !== new_size) {
      var old = wasmosFbuf.table[h];
      var nd = new Uint8Array(new_size);
      nd.set(old.subarray(0, Math.min(size, new_size)));
      wasmosFbuf.table[h] = nd;
    }
    HEAPU32[bs >> 2] = h;
    HEAPU32[(bs + 4) >> 2] = new_size;
    return 0;
  },
  file_buffer_reset__deps: ['file_buffer_resize', 'file_buffer_init'],
  file_buffer_reset: function (bs) {
    _file_buffer_resize(bs, 0);
    _file_buffer_init(bs);
  },
  file_buffer_write__deps: ['$wasmosFbuf'],
  file_buffer_write: function (bs, offset, buf, size) {
    var h = HEAPU32[bs >> 2];
    if (h) wasmosFbuf.table[h].set(HEAPU8.subarray(buf, buf + size), offset);
  },
  file_buffer_read__deps: ['$wasmosFbuf'],
  file_buffer_read: function (bs, offset, buf, size) {
    var h = HEAPU32[bs >> 2];
    if (h) HEAPU8.set(wasmosFbuf.table[h].subarray(offset, offset + size), buf);
  },
  file_buffer_set__deps: ['$wasmosFbuf'],
  file_buffer_set: function (bs, offset, val, size) {
    var h = HEAPU32[bs >> 2];
    if (h) wasmosFbuf.table[h].fill(val, offset, offset + size);
  },
});
