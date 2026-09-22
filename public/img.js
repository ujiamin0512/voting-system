// Downscales a chosen image file to a small JPEG data URL before upload.
// Phone photos are several MB and Vercel rejects request bodies over 4.5 MB.
// Shared by the admin panel and the participant submit page.
window.toDataUrl = (file, maxPx = 640) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = reject;
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => resolve(reader.result); // not decodable? send as-is
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv.toDataURL('image/jpeg', 0.82));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});
