import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  axes,
  quarterTurn,
  snapPosition,
  type PasteTransform,
} from "./scene-transform";
import type { VoxelPoint } from "./scene-data";

export class SceneGizmo {
  readonly anchor = new THREE.Object3D();
  readonly controls: TransformControls;
  private offset = { x: 0, z: 0 };
  private step = 1;
  private capture: (event: PointerEvent) => void;
  constructor(
    camera: THREE.Camera,
    element: HTMLElement,
    world: THREE.Scene,
    change: (origin: VoxelPoint, rotation: [number, number, number]) => void,
    block: (active: boolean) => void,
  ) {
    this.controls = new TransformControls(camera, element);
    this.controls.setSize(0.85);
    this.controls.setSpace("world");
    this.anchor.rotation.order = "ZYX";
    this.controls.attach(this.anchor);
    this.controls.showX = this.controls.showY = this.controls.showZ = true;
    this.controls.showE = this.controls.showXYZE = false;
    const helper = this.controls.getHelper();
    world.add(this.anchor, helper);
    this.controls.addEventListener("dragging-changed", (event) =>
      block(!!event.value),
    );
    this.controls.addEventListener("objectChange", () => {
      const origin = snapPosition(
        {
          x: this.anchor.position.x + this.offset.x,
          y: this.anchor.position.y,
          z: this.anchor.position.z + this.offset.z,
        },
        this.step,
      );
      const rotation = axes.map((axis) =>
        quarterTurn(THREE.MathUtils.radToDeg(this.anchor.rotation[axis])),
      ) as [number, number, number];
      change(origin, rotation);
    });
    this.capture = (event) => {
      if (event.button === 0 && this.controls.enabled && this.controls.axis)
        block(true);
    };
    element.addEventListener("pointerdown", this.capture, true);
    this.dispose = () => {
      element.removeEventListener("pointerdown", this.capture, true);
      this.controls.dispose();
      world.remove(this.anchor, helper);
    };
  }
  sync(
    origin: VoxelPoint,
    transform: PasteTransform,
    x: number,
    z: number,
    visible: boolean,
    mode: "translate" | "rotate",
    step: number,
    enabled: boolean,
  ) {
    this.offset = { x, z };
    this.step = step;
    if (this.controls.dragging && (!visible || !enabled)) {
      this.controls.reset();
      this.controls.dragging = false;
      this.controls.axis = null;
    }
    this.controls.enabled = visible && enabled;
    this.controls.getHelper().visible = visible;
    this.controls.setMode(mode);
    this.controls.setTranslationSnap(Math.max(1, step));
    this.controls.setRotationSnap(Math.PI / 2);
    if (!this.controls.dragging) {
      this.anchor.position.set(origin.x - x, origin.y, origin.z - z);
      this.anchor.rotation.set(
        ...(transform.rotation.map(THREE.MathUtils.degToRad) as [
          number,
          number,
          number,
        ]),
        "ZYX",
      );
    }
  }
  dispose: () => void;
}
