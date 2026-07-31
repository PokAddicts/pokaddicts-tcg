/* ==========================================================================
   PokAddicts - Card Image Viewer
   A tiny full-screen lightbox for viewing a card image at full size -
   opened by clicking a card thumbnail (Intake's confirm-preview, etc.),
   closed via the X button, clicking the backdrop, or Escape. One shared
   overlay element, created lazily on first use and reused after that.
   ========================================================================== */

function openImageViewer(url, altText) {
  if (!url) return;

  let overlay = document.getElementById('image-viewer-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'image-viewer-overlay';
    overlay.className = 'image-viewer-overlay';
    overlay.innerHTML = `
      <button type="button" class="image-viewer-close" aria-label="Close">&times;</button>
      <img class="image-viewer-img">
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeImageViewer();
    });
    overlay.querySelector('.image-viewer-close').addEventListener('click', closeImageViewer);
    document.body.appendChild(overlay);
  }

  const img = overlay.querySelector('.image-viewer-img');
  img.src = url;
  img.alt = altText || '';
  overlay.classList.add('active');
}

function closeImageViewer() {
  document.getElementById('image-viewer-overlay')?.classList.remove('active');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeImageViewer();
});

window.openImageViewer = openImageViewer;
window.closeImageViewer = closeImageViewer;
