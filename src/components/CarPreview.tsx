'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { loadCar, disposeObject } from '@/rendering/VehicleLayer';
import type { Car } from '@/config/vehicle.config';

/** Slowly turning car, framed to fill its box. */
export default function CarPreview({ car }: { car: Car }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    let disposed = false;
    let frame = 0;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0, 0);
    el.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x77745a, 3));
    const light = new THREE.DirectionalLight(0xffffff, 4);
    light.position.set(3, 6, 4);
    scene.add(light);

    let model: THREE.Object3D | undefined;
    // the car turning in place: its footprint radius and height decide the framing
    let reach = 2.3;
    let height = 1.4;
    const center = new THREE.Vector3(0, 0.7, 0);
    const ELEVATION = THREE.MathUtils.degToRad(16);
    // as close as possible while the car fits at every angle of its turn
    const frameCar = () => {
      const aspect = camera.aspect || 1;
      const vTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const hTan = vTan * aspect;
      const vExtent = (height / 2) * Math.cos(ELEVATION) + reach * Math.sin(ELEVATION);
      // the near end of the car comes closer to the camera: leave room for perspective
      const fit = Math.max(reach / hTan, vExtent / vTan);
      const distance = (fit + reach * 1.05) * 1.15; // a little air around it
      camera.position.set(0, center.y + Math.sin(ELEVATION) * distance, Math.cos(ELEVATION) * distance);
      camera.lookAt(center);
    };
    loadCar(car).then((m) => {
      if (disposed) { disposeObject(m); return; }
      // a pivot at the car's centre, so it turns in place
      const pivot = new THREE.Group();
      pivot.add(m);
      model = pivot;
      scene.add(pivot);
      const box = new THREE.Box3().setFromObject(m);
      const mid = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      // turn around the car's own centre
      m.position.x -= mid.x;
      m.position.z -= mid.z;
      reach = Math.hypot(size.x, size.z) / 2;
      height = size.y;
      center.y = mid.y;
      frameCar();
    }).catch(() => { el.dataset.error = 'Модель появится на карте'; });

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
      if (model) model.rotation.y += 0.004;
      renderer.render(scene, camera);
    };
    draw();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [car]);
  return <div className="car-preview" ref={host} />;
}
