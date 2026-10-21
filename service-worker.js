'use strict';

// The toolbar action grants temporary access to this tab. No all-sites access.
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  const tabId = tab.id;
  try {
    const url = new URL(tab.url || '');
    if (url.protocol !== 'https:' || url.hostname !== 'aistudio.google.com') {
      await showStatus(tabId, '!', 'Open Google AI Studio, then click Argon Bridge.');
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['bridge.js'],
      world: 'ISOLATED'
    });
    await showStatus(tabId, '', 'Open or restore Argon Bridge');
  } catch (error) {
    console.warn('Argon Bridge could not open:', error.message);
    await showStatus(tabId, '!', 'Argon Bridge could not open. Reload AI Studio and click again.');
  }
});

async function showStatus(tabId, text, title) {
  // A tab may close during injection; do not leave rejected promises behind.
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#b53a12' }),
    chrome.action.setTitle({ tabId, title })
  ]);
}
