// GLKVM Linker - Background Service Worker

const CONTEXT_MENU_ID = "glkvm-send-link";
const DEFAULT_DOMAIN = "glkvm.local";

// Register Context Menu
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Send to GLKVM",
      contexts: ["link"]
    });
  });
}

// Handle Context Menu Clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const linkUrl = info.linkUrl;
  if (!linkUrl) {
    showNotification("No URL Found", "The clicked element did not contain a valid hyperlink URL.");
    return;
  }
  await processLink(linkUrl);
});

// Locate the tab with domain glkvm.local
async function findGlkvmTab(targetDomain = DEFAULT_DOMAIN) {
  const domain = (targetDomain || DEFAULT_DOMAIN).toLowerCase().trim();
  const tabs = await chrome.tabs.query({});

  const matches = tabs.filter(tab => {
    if (!tab.url) return false;
    try {
      const u = new URL(tab.url);
      const host = u.hostname.toLowerCase();
      return host === domain || host.endsWith("." + domain);
    } catch {
      return false;
    }
  });

  if (matches.length === 0) {
    return null;
  }

  // Prefer currently active tab if among matches
  return matches.find(tab => tab.active) || matches[0];
}

// Helper to get stored settings
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({
      glkvmDomain: DEFAULT_DOMAIN,
      switchTab: false,
      showNotifications: true,
      appendNewline: true
    }, (items) => {
      resolve(items);
    });
  });
}

// Set extension badge temporarily
function setBadge(text, color = "#0ea5e9", durationMs = 3000) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
    if (durationMs > 0) {
      setTimeout(() => {
        chrome.action.setBadgeText({ text: "" });
      }, durationMs);
    }
  } catch {}
}

// Show notification
function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: title || "GLKVM Linker",
      message: message
    });
  } catch (err) {
    console.warn("Notification error:", err);
  }
}

// Helper functions nested so that executeScript injecting this function into GLKVM's page can do soup to nuts.
async function sendLinkToGlkvm(url, appendNewline = true) {
  function norm(s) {
    return (s || '')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[\s\u00a0]+/g, ' ')
      .trim();
  }

  function findElementByText(targetText, container = document) {
    if (!container) return null;
    const target = norm(targetText);

    // Check interactive elements for exact match
    const clickables = container.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
    for (const el of clickables) {
      if (norm(el.textContent) === target || norm(el.value) === target) {
        return el;
      }
    }

    return null;
  }

  async function waitForElement(finderFn, timeoutMs = 4000, intervalMs = 100) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const el = finderFn();
      if (el) return el;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  function clickElement(el) {
    if (!el) return;
    try {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (typeof el.focus === 'function') {
        el.focus();
      }
    } catch {}

    // Using native el.click() dispatches exactly one standard click event
    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }

  function findTextarea(root = document) {
    if (!root) return null;
    const textareas = Array.from(root.querySelectorAll('textarea'));
    if (textareas.length === 0) return null;

    // Filter for visible elements
    const visible = textareas.filter(ta => {
      const style = window.getComputedStyle(ta);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = ta.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    if (visible.length === 1) return visible[0];
    return textareas[0];
  }

  function pasteIntoTextarea(textarea, value) {
    try {
      textarea.focus();
    } catch {}

    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // -------------------------------------------------------------
  // Step 3: Click button with exact text "Ctrl-L + L"
  // -------------------------------------------------------------
  const ctrlLBtn = await waitForElement(() => findElementByText("Ctrl-L + L"), 3500);
  if (!ctrlLBtn) {
    return {
      success: false,
      error: 'Could not find button with exact text "Ctrl-L + L" on the GLKVM tab.'
    };
  }
  clickElement(ctrlLBtn);

  // -------------------------------------------------------------
  // Step 4: Paste URL into textarea component
  // -------------------------------------------------------------
  const textarea = await waitForElement(() => findTextarea(document), 4000);
  if (!textarea) {
    return {
      success: false,
      error: 'Could not find textarea component on the GLKVM tab after clicking "Ctrl-L + L".'
    };
  }
  const textToPaste = (appendNewline && !url.endsWith('\n')) ? (url + '\n') : url;
  pasteIntoTextarea(textarea, textToPaste);

  // -------------------------------------------------------------
  // Step 5: Click button with exact text "Paste To Remote Device"
  // -------------------------------------------------------------
  const pasteBtn = await waitForElement(() => findElementByText("Paste To Remote Device"), 4000);
  if (!pasteBtn) {
    return {
      success: false,
      error: 'Could not find button with exact text "Paste To Remote Device" on the GLKVM tab.'
    };
  }
  clickElement(pasteBtn);

  return {
    success: true,
    message: 'Successfully sent URL to remote device via GLKVM.'
  };
}

// Master handler for sending a link to GLKVM
let isProcessingLink = false;

async function processLink(url) {
  if (isProcessingLink) {
    console.warn("GLKVM Linker: Request already in progress, ignoring duplicate call.");
    return { success: false, error: "Already processing request" };
  }
  isProcessingLink = true;

  try {
    const settings = await getSettings();

    // 1. Locate the tab with domain glkvm.local
    const targetTab = await findGlkvmTab(settings.glkvmDomain);
    if (!targetTab) {
      setBadge("ERR", "#ef4444");
      if (settings.showNotifications) {
        showNotification(
          "GLKVM Tab Not Found",
          `Could not find an open tab with domain "${settings.glkvmDomain}". Please open GLKVM in a tab.`
        );
      }
      return { success: false, error: "Tab not found" };
    }

    // Optionally activate the GLKVM tab if configured
    if (settings.switchTab) {
      try {
        await chrome.tabs.update(targetTab.id, { active: true });
        if (targetTab.windowId) {
          await chrome.windows.update(targetTab.windowId, { focused: true });
        }
      } catch {}
    }

    // 3, 4, 5. Execute automation on the GLKVM tab
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: sendLinkToGlkvm,
        args: [url, settings.appendNewline !== false]
      });

      const res = results && results[0] && results[0].result;
      if (res && res.success) {
        setBadge("OK", "#10b981");
        if (settings.showNotifications) {
          showNotification("Sent to GLKVM", `Pasted URL to remote device:\n${url}`);
        }
        return { success: true };
      } else {
        const errMsg = (res && res.error) || "Action failed on GLKVM tab";
        setBadge("ERR", "#ef4444");
        if (settings.showNotifications) {
          showNotification("GLKVM Automation Error", errMsg);
        }
        return { success: false, error: errMsg };
      }
    } catch (err) {
      setBadge("ERR", "#ef4444");
      if (settings.showNotifications) {
        showNotification("GLKVM Error", err.message || String(err));
      }
      return { success: false, error: err.message || String(err) };
    }
  } finally {
    setTimeout(() => {
      isProcessingLink = false;
    }, 1200);
  }
}

// Messages from popup (status checks, manual paste, etc.)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_GLKVM_TAB") {
    getSettings().then(settings => {
      findGlkvmTab(settings.glkvmDomain).then(tab => {
        sendResponse({
          found: !!tab,
          tab: tab ? { id: tab.id, title: tab.title, url: tab.url } : null,
          domain: settings.glkvmDomain
        });
      });
    });
    return true; // async response
  }

  if (message.type === "SEND_URL_TO_GLKVM") {
    processLink(message.url).then(res => {
      sendResponse(res);
    });
    return true; // async response
  }
});
