async function bootstrapPersistedCourse() {
  try {
    const response = await fetch('/api/context', { cache: 'no-store' });
    if (!response.ok) return;
    const context = await response.json();
    if (!context.course) return;
    const image = document.querySelector('#imagePath');
    const annotation = document.querySelector('#annotationPath');
    const open = document.querySelector('#openRaster');
    if (!image || !annotation || !open) return;
    image.value = context.course.imagePath ?? '';
    annotation.value = context.course.annotationPath ?? '';
    open.click();
  } catch {
    // Persisted context is a convenience. The normal manual Open flow remains available.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapPersistedCourse, { once: true });
} else {
  bootstrapPersistedCourse();
}
