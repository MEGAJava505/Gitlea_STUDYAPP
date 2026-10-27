'use client';
import { useEffect, useState } from 'react';
type Material = { id: string; filename: string; size: number };
export function MaterialList({ lessonId }: { lessonId: string }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [status, setStatus] = useState('Loading materials…');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/lessons/' + lessonId + '/materials', { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? 'Materials unavailable');
      setMaterials(body.materials); setStatus(body.materials.length ? '' : 'No materials attached.');
    }).catch(error => { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Materials unavailable'); });
    return () => controller.abort();
  }, [lessonId]);
  return <><p role="status">{status}</p><ul>{materials.map(material => <li key={material.id}>{material.filename} ({material.size} bytes)</li>)}</ul>
    <p>File upload and download are not available yet. Material metadata alone is not a stored file.</p></>;
}
