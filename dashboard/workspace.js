// Acquisition owns the connection and mutable recording. Analysis receives a
// structured-cloned snapshot; never navigate or reload either existing window.
export function createExplorerWindow(owner, getSession, getState, onBlocked) {
  let explorer;
  const id = owner.crypto.randomUUID();
  owner.name = `pal-live-${id}`;
  const name = `pal-explorer-${id}`;
  const origin = owner.location.origin;
  const sendSnapshot = () => explorer.postMessage({type:'pal-session', session:getSession(), state:getState()}, origin);
  owner.addEventListener('message', event => {
    if (event.origin !== origin || event.source !== explorer) return;
    if (event.data?.type === 'pal-session-request') sendSnapshot();
    if (event.data?.type === 'pal-state-request') explorer.postMessage({type:'pal-state', state:getState()}, origin);
  });
  return () => {
    if (explorer && !explorer.closed) {
      (owner.open('', name) || explorer).focus();
      return; // Keep the analysis range/playback intact. Refresh is explicit.
    }
    explorer = owner.open('explorer.html', name);
    if (!explorer) onBlocked();
  };
}

export function returnToAcquisition(view) {
  try {
    if (view.opener && !view.opener.closed && view.opener.location.origin === view.location.origin) {
      // Chrome may ignore focus() on a background tab. Re-select its unique
      // browsing context with an empty URL: no navigation, reload or new tab.
      const owner = view.opener;
      (owner.name?.startsWith('pal-live-') ? view.open('', owner.name) || owner : owner).focus();
      return true;
    }
  } catch {} // The original window may have navigated to another origin.
  return false;
}
