document.addEventListener("DOMContentLoaded", async () => {
  const statusContainer = document.getElementById("status-container");
  const statusText = document.getElementById("status-text");
  const tabInfo = document.getElementById("tab-info");
  const refreshBtn = document.getElementById("refresh-status-btn");
  const openContainer = document.getElementById("open-glkvm-container");
  const openGlkvmBtn = document.getElementById("open-glkvm-btn");

  const domainInput = document.getElementById("glkvm-domain");
  const switchTabToggle = document.getElementById("switch-tab-toggle");
  const appendNewlineToggle = document.getElementById("append-newline-toggle");
  const notifToggle = document.getElementById("notifications-toggle");
  const saveBtn = document.getElementById("save-settings-btn");
  const settingsStatus = document.getElementById("settings-status");

  const testUrlInput = document.getElementById("test-url-input");
  const sendTestBtn = document.getElementById("send-test-btn");
  const testResult = document.getElementById("test-result");

  let currentTargetDomain = "glkvm.local";

  // Load saved settings
  const items = await chrome.storage.sync.get({
    glkvmDomain: "glkvm.local",
    switchTab: false,
    showNotifications: true,
    appendNewline: true
  });
  currentTargetDomain = items.glkvmDomain || "glkvm.local";
  domainInput.value = currentTargetDomain;
  switchTabToggle.checked = items.switchTab;
  appendNewlineToggle.checked = items.appendNewline !== false;
  notifToggle.checked = items.showNotifications;
  checkTabStatus();

  // Check tab status
  async function checkTabStatus() {
    statusContainer.className = "status-box status-loading";
    statusText.textContent = "Checking for GLKVM tab...";
    tabInfo.classList.add("hidden");
    openContainer.classList.add("hidden");

    try {
      const response = await chrome.runtime.sendMessage({ type: "CHECK_GLKVM_TAB" });

      if (response && response.found && response.tab) {
        statusContainer.className = "status-box status-connected";
        statusText.textContent = "GLKVM tab detected";
        tabInfo.textContent = `${response.tab.title || "Tab"} (${response.tab.url})`;
        tabInfo.classList.remove("hidden");
        openContainer.classList.add("hidden");
      } else {
        statusContainer.className = "status-box status-disconnected";
        statusText.textContent = `No tab with "${response?.domain || currentTargetDomain}" found`;
        openContainer.classList.remove("hidden");
      }
    } catch {
      statusContainer.className = "status-box status-disconnected";
      statusText.textContent = "Unable to query tabs";
    }
  }

  // Refresh status button
  refreshBtn.addEventListener("click", () => {
    checkTabStatus();
  });

  // Open GLKVM button
  openGlkvmBtn.addEventListener("click", () => {
    const domain = domainInput.value.trim() || "glkvm.local";
    const targetUrl = domain.startsWith("http://") || domain.startsWith("https://") 
      ? domain 
      : `http://${domain}`;
    chrome.tabs.create({ url: targetUrl });
    setTimeout(checkTabStatus, 1000);
  });

  // Save Settings
  saveBtn.addEventListener("click", async () => {
    const newDomain = domainInput.value.trim() || "glkvm.local";
    const switchTab = switchTabToggle.checked;
    const appendNewline = appendNewlineToggle.checked;
    const showNotifications = notifToggle.checked;

    await chrome.storage.sync.set({
      glkvmDomain: newDomain,
      switchTab: switchTab,
      appendNewline: appendNewline,
      showNotifications: showNotifications
    });

    currentTargetDomain = newDomain;
    settingsStatus.className = "result-msg success";
    settingsStatus.textContent = "Settings saved successfully!";
    settingsStatus.classList.remove("hidden");
    setTimeout(() => {
      settingsStatus.classList.add("hidden");
    }, 2500);
    checkTabStatus();
  });

  // Send Test URL
  sendTestBtn.addEventListener("click", async () => {
    const url = testUrlInput.value.trim();
    if (!url) {
      testResult.className = "result-msg error";
      testResult.textContent = "Please enter a valid URL first.";
      testResult.classList.remove("hidden");
      return;
    }

    sendTestBtn.disabled = true;
    sendTestBtn.textContent = "Sending...";
    testResult.classList.add("hidden");

    try {
      const res = await chrome.runtime.sendMessage({
        type: "SEND_URL_TO_GLKVM",
        url: url
      });

      if (res && res.success) {
        testResult.className = "result-msg success";
        testResult.textContent = "URL sent to remote device successfully!";
      } else {
        testResult.className = "result-msg error";
        testResult.textContent = (res && res.error) || "Failed to send URL to GLKVM.";
      }
    } catch (err) {
      testResult.className = "result-msg error";
      testResult.textContent = err?.message || "Failed to send URL to GLKVM.";
    } finally {
      sendTestBtn.disabled = false;
      sendTestBtn.textContent = "Send";
      testResult.classList.remove("hidden");
    }
  });
});
