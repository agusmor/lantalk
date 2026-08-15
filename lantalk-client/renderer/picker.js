// Picker window renderer. Receives the list of shareable screens/windows
// from the main process (with thumbnail data URLs already generated) and
// reports back whichever one gets clicked. Closing the window without
// clicking anything counts as a cancel — main.js handles that via the
// window's 'closed' event, nothing needed here for that case.

const { ipcRenderer } = require('electron');

const gridEl = document.getElementById('grid');

ipcRenderer.on('sources', (_event, sources) => {
  gridEl.innerHTML = '';

  if (sources.length === 0) {
    gridEl.innerHTML = '<div class="empty">Nothing available to share.</div>';
    return;
  }

  for (const source of sources) {
    const btn = document.createElement('button');
    btn.className = 'source-btn';
    btn.innerHTML = `<img src="${source.thumbnail}" /><div class="source-name"></div>`;
    btn.querySelector('.source-name').textContent = source.name;
    btn.onclick = () => ipcRenderer.send('picker:selected', source.id);
    gridEl.appendChild(btn);
  }
});
