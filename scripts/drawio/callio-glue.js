
/* ---- Callio: added to PostConfig.js by scripts/build-drawio.mjs ---- */
// draw.io runs in a frame inside Callio, where new browser windows aren't wanted: print, print
// preview and PDF (which draw.io makes with the print dialog when no export server is set) open
// in an overlay inside the editor instead of a popup window, and web links (Help, shape
// libraries' sites) open in the default browser through Callio.
(function()
{
	var post = function(msg) { try { (window.opener || window.parent).postMessage(JSON.stringify(msg), '*'); } catch (e) { /* ignore */ } };

	// the print overlay is a frame of this page: its resources are already loaded
	if (typeof PrintDialog !== 'undefined') { PrintDialog.printTimeout = 2500; }

	window.open = function(url)
	{
		if (url != null && url !== '' && url !== 'about:blank')
		{
			post({event: 'callio-open-url', url: String(url)});
			return null;
		}

		var wrap = document.createElement('div');
		wrap.className = 'callio-print';
		wrap.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;background:rgba(0,0,0,.55);' +
			'display:flex;flex-direction:column;padding:20px 28px 28px;box-sizing:border-box;font:13px system-ui,sans-serif';
		var bar = document.createElement('div');
		bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px';
		var frame = document.createElement('iframe');
		frame.style.cssText = 'flex:1;border:0;background:#fff;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.4)';
		var button = function(label, primary, fn)
		{
			var b = document.createElement('button');
			b.textContent = label;
			b.style.cssText = 'padding:6px 16px;border-radius:6px;border:1px solid ' + (primary ? '#c9962e' : '#888') + ';' +
				'background:' + (primary ? '#e0b04e' : '#fff') + ';color:#111;cursor:pointer;font:inherit';
			b.onclick = fn;
			bar.appendChild(b);
		};
		wrap.appendChild(bar);
		wrap.appendChild(frame);
		document.body.appendChild(wrap);
		var wnd = frame.contentWindow;
		var close = function() { if (wrap.parentNode != null) { wrap.parentNode.removeChild(wrap); } };
		button(mxResources.get('print') || 'Print', true, function() { wnd.focus(); wnd.print(); });
		button(mxResources.get('close') || 'Close', false, close);

		try { wnd.close = close; } catch (e) { /* ignore */ }
		try { wnd.opener = window; } catch (e) { /* ignore */ }

		return wnd;
	};
})();
