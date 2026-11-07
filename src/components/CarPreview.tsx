'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadCar, disposeObject } from '@/rendering/VehicleLayer';
import type { Car } from '@/config/vehicle.config';

/** Car preview: drag to spin; idle auto-turn resumes after a pause. */
export default function CarPreview({ car }: { car: Car }) {
  const host = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const el = host.current!;
    let disposed = false;
    let frame = 0;
    setLoading(true);
    delete el.dataset.error;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    renderer.setClearColor(0, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.appendChild(renderer.domElement);
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6a6558, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(3.2, 5.5, 4);
    scene.add(key);
    // soft rim — light lacquer catch without a hard glare
    const rim = new THREE.DirectionalLight(0xdfe8ff, 1.2);
    rim.position.set(-4, 3, -2.5);
    scene.add(rim);

    let model: THREE.Object3D | undefined;
    let reach = 2.3;
    let height = 1.4;
    const center = new THREE.Vector3(0, 0.7, 0);
    const ELEVATION = THREE.MathUtils.degToRad(16);
    let dragging = false;
    let lastX = 0;
    let autoResumeAt = 0;

    const frameCar = () => {
      const aspect = camera.aspect || 1;
      const vTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const hTan = vTan * aspect;
      const vExtent = (height / 2) * Math.cos(ELEVATION) + reach * Math.sin(ELEVATION);
      const fit = Math.max(reach / hTan, vExtent / vTan);
      const distance = (fit + reach * 1.05) * 1.12 / 1.16;
      camera.position.set(0, center.y + Math.sin(ELEVATION) * distance, Math.cos(ELEVATION) * distance);
      camera.lookAt(center);
    };
    loadCar(car).then((m) => {
      if (disposed) { disposeObject(m); return; }
      const pivot = new THREE.Group();
      pivot.add(m);
      model = pivot;
      scene.add(pivot);
      const box = new THREE.Box3().setFromObject(m);
      const mid = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      m.position.x -= mid.x;
      m.position.z -= mid.z;
      reach = Math.hypot(size.x, size.z) / 2;
      height = size.y;
      center.y = mid.y;
      frameCar();
      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      el.dataset.error = 'Модель появится на карте';
      setLoading(false);
    });

    const pointerX = (e: PointerEvent) => e.clientX;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !model) return;
      dragging = true;
      lastX = pointerX(e);
      el.style.cursor = 'grabbing';
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging || !model) return;
      const x = pointerX(e);
      model.rotation.y += (x - lastX) * 0.01;
      lastX = x;
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'grab';
      autoResumeAt = performance.now() + 1800;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);

    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camera.updateProjectionMatrix();
      frameCar();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (model && !dragging && performance.now() >= autoResumeAt) model.rotation.y += 0.004;
      renderer.render(scene, camera);
    };
    draw();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [car]);
  return (
    <div className="car-preview" ref={host}>
      {loading && <span className="car-preview-spinner" aria-hidden />}
    </div>
  );
}
