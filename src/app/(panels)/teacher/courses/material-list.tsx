'use client';
import { useEffect, useState } from 'react';
type Material = { id: string; filename: string; size: number; contentType?: string };
export function MaterialList({ lessonId, canUpload = false }: { lessonId: string; canUpload?: boolean }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [status, setStatus] = useState('Loading materials…');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/lessons/' + lessonId + '/materials', { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? 'Materials unavailable');
      setMaterials(body.materials); setStatus(body.materials.length ? '' : 'No materials attached.');
    }).catch(error => { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Materials unavailable'); });
    return () => controller.abort();
  }, [lessonId]);
  async function upload(event: React.FormEvent) {
    event.preventDefault(); if (!file) return;
    setUploading(true); setStatus('Uploading…');
    const form = new FormData(); form.set('file', file);
    const response = await fetch('/api/v1/lessons/' + lessonId + '/materials/upload', { method: 'POST', body: form });
    const body = await response.json(); setUploading(false);
    if (!response.ok) { setStatus(body.error?.message ?? 'Upload failed'); return; }
    setMaterials(current => [...current, body.material]); setFile(null); setStatus('Uploaded.');
  }
  return <><p role="status">{status}</p>{canUpload && <form onSubmit={upload}><label>Upload material <input type="file" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label><button type="submit" disabled={!file || uploading}>Upload</button></form>}<ul>{materials.map(material => <li key={material.id}><a href={'/api/v1/materials/' + material.id + '/download'}>{material.filename}</a> ({material.size} bytes)</li>)}</ul></>;
}
