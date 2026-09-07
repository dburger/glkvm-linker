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
  await processLink(linkUrl, tab);
});

// Setup offscreen document for clipboard operations
let offscreenCreationPromise = null;
async function setupOffscreenDocument(path = "offscreen.html") {
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (offscreenCreationPromise) {
    await offscreenCreationPromise;
  } else {
    offscreenCreationPromise = chrome.offscreen.createDocument({
      url: path,
      reasons: ["CLIPBOARD"],
      justification: "Copy hyperlink URL to system clipboard"
    });
    await offscreenCreationPromise;
    offscreenCreationPromise = null;
  }
}

// 1. Copy URL to system clipboard
async function copyToClipboard(text, sourceTab) {
  let copied = false;

  // Try offscreen document first
  try {
    await setupOffscreenDocument();
    const res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "copy-to-clipboard",
      data: text
    });
    if (res && res.success) {
      copied = true;
    }
  } catch (err) {
    console.warn("Offscreen clipboard copy failed:", err);
  }

  // Also try in source tab if feasible
  if (!copied && sourceTab && sourceTab.id && sourceTab.url && !sourceTab.url.startsWith("chrome")) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: sourceTab.id },
        func: (urlText) => {
          try {
            navigator.clipboard.writeText(urlText).catch(() => {
              const ta = document.createElement("textarea");
              ta.value = urlText;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
            });
          } catch {}
        },
        args: [text]
      });
      copied = true;
    } catch {}
  }

  return copied;
}

// 2. Locate the tab with domain glkvm.local
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

// Automation function executed inside the GLKVM tab
async function automateGlkvmActions(url, appendNewline = true) {
  const norm = (s) => (s || '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();

  // Helper to find an element matching exact text
  function findElementByText(targetText, container = document) {
    const target = norm(targetText);

    function searchRoot(root) {
      if (!root) return null;

      // 1. Check interactive elements
      const clickables = root.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
      for (const el of clickables) {
        if (norm(el.textContent) === target || norm(el.value) === target) {
          return el;
        }
      }

      // 2. Search all elements, finding the deepest element with the exact text
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          const shadowFound = searchRoot(el.shadowRoot);
          if (shadowFound) return shadowFound;
        }
        if (norm(el.textContent) === target) {
          let childHasText = false;
          for (const child of el.children) {
            if (norm(child.textContent) === target) {
              childHasText = true;
              break;
            }
          }
          if (!childHasText) {
            return el.closest('button, [role="button"], a') || el;
          }
        }
      }
      return null;
    }

    // Pass 1: exact match
    const exact = searchRoot(container);
    if (exact) return exact;

    // Pass 2: aria-label or title attributes
    const attrMatch = container.querySelector(`[aria-label="${targetText}"], [title="${targetText}"]`);
    if (attrMatch) return attrMatch;

    // Pass 3: case-insensitive match fallback
    const targetLower = target.toLowerCase();
    const all = container.querySelectorAll('button, [role="button"], a, div, span');
    for (const el of all) {
      if (norm(el.textContent).toLowerCase() === targetLower) {
        return el.closest('button, [role="button"], a') || el;
      }
    }

    return null;
  }

  // Helper to wait for an element with polling
  async function waitForElement(finderFn, timeoutMs = 4000, intervalMs = 100) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const el = finderFn();
      if (el) return el;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  // Clean single-click simulation (avoids duplicate event triggers)
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

    // Using native el.click() dispatches exactly one standard click event.
    // Dispatching synthetic MouseEvents alongside el.click() previously caused
    // event listeners to execute multiple times simultaneously.
    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }

  // Helper to find the textarea
  function findTextarea(root = document) {
    const textareas = Array.from(root.querySelectorAll('textarea'));

    // Check shadow roots
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        const inShadow = findTextarea(el.shadowRoot);
        if (inShadow) return inShadow;
      }
    }

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
    if (visible.length > 1) {
      // Prioritize modal/dialog container
      const dialogArea = visible.find(ta =>
        ta.closest('dialog, [role="dialog"], .modal, .dialog, .drawer, .clipboard, .toolbox')
      );
      if (dialogArea) return dialogArea;
      return visible[visible.length - 1];
    }

    return textareas[0];
  }

  // Set textarea value compatible with React/Vue/vanilla
  function pasteIntoTextarea(textarea, value) {
    try {
      textarea.focus();
    } catch {}

    // Clear any existing content first
    textarea.value = '';

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(textarea, value);
    } else {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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

  // Allow DOM/modal to open
  await new Promise(r => setTimeout(r, 200));

  // -------------------------------------------------------------
  // Step 4: Paste copied URL into textarea component
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

  // Allow input state updates to settle
  await new Promise(r => setTimeout(r, 150));

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

async function processLink(url, sourceTab) {
  if (isProcessingLink) {
    console.warn("GLKVM Linker: Request already in progress, ignoring duplicate call.");
    return { success: false, error: "Already processing request" };
  }
  isProcessingLink = true;

  try {
    const settings = await getSettings();

    // 1. Copy URL to clipboard
    await copyToClipboard(url, sourceTab);

    // 2. Locate the tab with domain glkvm.local
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
        func: automateGlkvmActions,
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
    processLink(message.url, null).then(res => {
      sendResponse(res);
    });
    return true; // async response
  }
});
