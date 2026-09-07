// Handles clipboard write operations requested by the background service worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen' || message.type !== 'copy-to-clipboard') {
    return false;
  }

  const text = message.data;
  let success = false;

  try {
    const textarea = document.getElementById('clipboard-area');
    textarea.value = text;
    textarea.select();
    textarea.setSelectionRange(0, 999999);
    success = document.execCommand('copy');
  } catch (err) {
    console.warn('[GLKVM Linker Offscreen] execCommand failed:', err);
  }

  if (success) {
    sendResponse({ success: true });
    return false;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[GLKVM Linker Offscreen] navigator.clipboard failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  sendResponse({ success: false, error: 'Clipboard write unavailable' });
  return false;
});
