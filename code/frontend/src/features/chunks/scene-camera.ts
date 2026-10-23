import * as THREE from "three";
import { FLIGHT_SPEED } from "@/lib/constants";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
export class SceneCamera {
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.08, 4096);
  readonly topCamera = new THREE.OrthographicCamera(
    -64,
    64,
    64,
    -64,
    0.08,
    8192,
  );
  readonly orbit: OrbitControls;
  mode: "orbit" | "fly" | "top" = "orbit";
  speed = FLIGHT_SPEED.default / FLIGHT_SPEED.base;
  blocked = false;
  private keys = new Set<string>();
  private dragging = false;
  private lookStart = 0;
  private wasLooking = false;
  private lookPointer: number | null = null;
  private topSpan = 64;
  private perspectiveRotation = new THREE.Quaternion();
  private perspectivePosition = new THREE.Vector3();
  private perspectiveTarget = new THREE.Vector3();
  private topPosition: THREE.Vector3 | null = null;
  private topYaw = 180;
  private listeners: (() => void)[] = [];
  get looking() {
    return this.mode === "fly" && this.dragging;
  }
  constructor(
    readonly element: HTMLCanvasElement,
    x: number,
    z: number,
    private onSpeed?: (speed: number) => void,
  ) {
    this.camera.position.set(x + 48, 140, z + 48);
    this.orbit = new OrbitControls(this.camera, element);
    this.orbit.target.set(x, 64, z);
    this.orbit.minDistance = 0.3;
    this.orbit.maxDistance = 1500;
    this.orbit.enableDamping = true;
    this.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    const on = (target: EventTarget, type: string, listener: EventListener) => {
      target.addEventListener(type, listener);
      this.listeners.push(() => target.removeEventListener(type, listener));
    };
    on(element, "keydown", ((e: KeyboardEvent) => {
      if (e.code === "Escape") this.release();
      if (
        this.blocked ||
        this.mode === "orbit" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (
        [
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
          "Space",
          "ShiftLeft",
          "ShiftRight",
        ].includes(e.code)
      ) {
        e.preventDefault();
        this.keys.add(e.code);
      }
    }) as EventListener);
    on(window, "keyup", ((e: KeyboardEvent) => {
      this.keys.delete(e.code);
    }) as EventListener);
    on(window, "blur", () => this.release());
    on(element, "blur", () => this.release());
    on(document, "visibilitychange", () => this.release());
    on(element, "pointerdown", ((e: PointerEvent) => {
      element.focus();
      if (
        this.mode !== "orbit" &&
        !this.blocked &&
        e.button === 2 &&
        !e.shiftKey
      ) {
        this.wasLooking = this.dragging;
        this.lookPointer = e.pointerId;
        this.lookStart = performance.now();
        this.dragging = true;
        element.setPointerCapture(e.pointerId);
      }
    }) as EventListener);
    on(element, "pointerup", ((e: PointerEvent) => {
      if (e.button !== 2 || e.shiftKey || this.lookPointer !== e.pointerId)
        return;
      this.lookPointer = null;
      const keep =
        this.mode === "fly" &&
        !this.wasLooking &&
        performance.now() - this.lookStart < 200;
      this.dragging = keep;
      if (keep && element.requestPointerLock) {
        try {
          const request = element.requestPointerLock();
          request?.catch(() => {
            this.dragging = false;
          });
        } catch {
          this.dragging = false;
        }
      } else if (document.pointerLockElement === element)
        document.exitPointerLock();
    }) as EventListener);
    on(document, "pointerlockchange", () => {
      if (document.pointerLockElement !== element) this.release();
    });
    on(element, "pointercancel", () => this.release());
    on(element, "wheel", ((e: WheelEvent) => {
      if (this.mode === "orbit" || this.blocked || e.ctrlKey || e.metaKey)
        return;
      e.preventDefault();
      if (this.mode === "top") {
        this.topSpan = Math.max(
          2,
          Math.min(1024, this.topSpan * (e.deltaY < 0 ? 1 / 1.1 : 1.1)),
        );
        this.resize(element.clientWidth, element.clientHeight);
        return;
      }
      this.setSpeed(this.speed * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      this.onSpeed?.(this.speed);
    }) as EventListener);
    on(element, "pointermove", ((e: PointerEvent) => {
      if (this.mode === "orbit" || !this.dragging || this.blocked) return;
      if (this.mode === "top") {
        const unit = (2 * this.topSpan) / Math.max(1, element.clientHeight);
        const delta = new THREE.Vector3(e.movementX, -e.movementY, 0)
          .applyQuaternion(this.camera.quaternion)
          .multiplyScalar(unit);
        delta.y = 0;
        this.camera.position.sub(delta);
        return;
      }
      const current = this.angles();
      const angles = new THREE.Euler(
        -THREE.MathUtils.degToRad(current.pitch),
        THREE.MathUtils.degToRad(180 - current.yaw),
        0,
        "YXZ",
      );
      angles.y -= e.movementX * 0.003;
      angles.x = THREE.MathUtils.clamp(
        angles.x - e.movementY * 0.003,
        -Math.PI / 2 + 0.01,
        Math.PI / 2 - 0.01,
      );
      this.camera.quaternion.setFromEuler(angles);
    }) as EventListener);
  }
  get viewCamera(): THREE.Camera {
    if (this.mode !== "top") return this.camera;
    this.topCamera.position.copy(this.camera.position);
    this.topCamera.position.y = 4096;
    this.topCamera.quaternion.copy(this.camera.quaternion);
    this.topCamera.updateMatrixWorld();
    return this.topCamera;
  }
  resize(width: number, height: number) {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.topCamera.left = -this.topSpan * this.camera.aspect;
    this.topCamera.right = this.topSpan * this.camera.aspect;
    this.topCamera.top = this.topSpan;
    this.topCamera.bottom = -this.topSpan;
    this.topCamera.updateProjectionMatrix();
  }
  unitsPerPixel(distance: number, height: number) {
    return (
      (this.mode === "top"
        ? 2 * this.topSpan
        : 2 *
          distance *
          Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) /
      Math.max(1, height)
    );
  }
  fitTop(extent: number) {
    this.topSpan = Math.max(2, Math.min(1024, extent));
    this.resize(this.element.clientWidth, this.element.clientHeight);
  }
  setMode(mode: "orbit" | "fly" | "top") {
    if (mode === this.mode) return;
    this.release();
    const leavingTop = this.mode === "top";
    if (this.mode === "top") {
      this.topPosition = this.camera.position.clone();
      this.camera.position.copy(this.perspectivePosition);
      this.orbit.target.copy(this.perspectiveTarget);
      this.camera.quaternion.copy(this.perspectiveRotation);
    }
    if (mode === "top") {
      this.perspectivePosition.copy(this.camera.position);
      this.perspectiveTarget.copy(this.orbit.target);
      this.perspectiveRotation.copy(this.camera.quaternion);
      if (this.topPosition) this.camera.position.copy(this.topPosition);
      this.camera.quaternion.setFromEuler(
        new THREE.Euler(
          -Math.PI / 2,
          THREE.MathUtils.degToRad(180 - this.topYaw),
          0,
          "YXZ",
        ),
      );
    }
    if (mode === "orbit" && !leavingTop)
      this.orbit.target
        .copy(this.camera.position)
        .add(
          this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(32),
        );
    this.mode = mode;
    this.orbit.enabled = mode === "orbit" && !this.blocked;
    if (mode === "orbit") this.orbit.update();
  }
  setSpeed(speed: number) {
    this.speed =
      Number.isFinite(speed) && speed > 0
        ? Math.max(
            FLIGHT_SPEED.min / FLIGHT_SPEED.base,
            Math.min(FLIGHT_SPEED.max / FLIGHT_SPEED.base, speed),
          )
        : FLIGHT_SPEED.default / FLIGHT_SPEED.base;
  }
  angles() {
    if (this.mode === "top") return { yaw: this.topYaw, pitch: 90 };
    // Camera-right stays horizontal even when looking straight up/down.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(
      this.camera.quaternion,
    );
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    return {
      yaw:
        THREE.MathUtils.euclideanModulo(
          180 - THREE.MathUtils.radToDeg(Math.atan2(-right.z, right.x)) + 180,
          360,
        ) - 180,
      pitch: THREE.MathUtils.radToDeg(
        Math.asin(THREE.MathUtils.clamp(-forward.y, -1, 1)),
      ),
    };
  }
  setAngles(yaw: number, pitch: number) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    yaw = THREE.MathUtils.euclideanModulo(yaw + 180, 360) - 180;
    if (this.mode === "top") this.topYaw = yaw;
    // Flush OrbitControls' residual motion before applying an explicit direction.
    const damping = this.orbit.enableDamping;
    const eye = this.camera.position.clone();
    const distance = Math.max(0.3, eye.distanceTo(this.orbit.target));
    if (this.mode === "orbit") {
      this.orbit.enableDamping = false;
      this.orbit.update();
    }
    this.camera.position.copy(eye);
    this.camera.quaternion.setFromEuler(
      new THREE.Euler(
        -THREE.MathUtils.degToRad(
          this.mode === "top" ? 90 : THREE.MathUtils.clamp(pitch, -90, 90),
        ),
        THREE.MathUtils.degToRad(180 - yaw),
        0,
        "YXZ",
      ),
    );
    this.orbit.target
      .copy(this.camera.position)
      .add(
        this.camera
          .getWorldDirection(new THREE.Vector3())
          .multiplyScalar(distance),
      );
    if (this.mode === "orbit") this.orbit.update();
    this.orbit.enableDamping = damping;
    this.camera.updateMatrixWorld();
  }
  rebase(dx: number, dz: number) {
    const delta = new THREE.Vector3(dx, 0, dz);
    this.camera.position.sub(delta);
    this.orbit.target.sub(delta);
    this.perspectivePosition.sub(delta);
    this.perspectiveTarget.sub(delta);
    this.topPosition?.sub(delta);
  }
  moveTo(x: number, y: number, z: number) {
    const delta = new THREE.Vector3(x, y, z).sub(this.camera.position);
    this.camera.position.add(delta);
    this.orbit.target.add(delta);
    this.camera.updateMatrixWorld();
  }
  target() {
    return this.mode === "orbit"
      ? this.orbit.target.clone()
      : this.camera.position
          .clone()
          .add(
            this.camera
              .getWorldDirection(new THREE.Vector3())
              .multiplyScalar(32),
          );
  }
  tick(dt: number, editing: boolean) {
    this.orbit.enabled = this.mode === "orbit" && !this.blocked;
    this.orbit.enableRotate = !editing;
    if (this.blocked) {
      this.release();
      return;
    }
    if (this.mode === "orbit") {
      this.orbit.update();
      return;
    }
    const forward =
      Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const strafe =
      Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    const vertical =
      Number(this.keys.has("Space")) -
      Number(this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"));
    if (forward || strafe || vertical) {
      // Minecraft flight uses the camera yaw for WASD and keeps vertical
      // movement on its own axis, so looking down does not turn strafing into
      // an unintended climb or descent.
      const yaw = new THREE.Euler(0, 0, 0, "YXZ");
      yaw.y = THREE.MathUtils.degToRad(180 - this.angles().yaw);
      const vector = new THREE.Vector3(strafe, vertical, -forward)
        .applyEuler(new THREE.Euler(0, yaw.y, 0))
        .normalize()
        .multiplyScalar(Math.min(dt, 0.05) * FLIGHT_SPEED.base * this.speed);
      this.camera.position.add(vector);
    }
  }
  release() {
    this.keys.clear();
    this.dragging = false;
    this.lookPointer = null;
    if (document.pointerLockElement === this.element)
      document.exitPointerLock();
  }
  dispose() {
    this.release();
    this.orbit.dispose();
    this.listeners.forEach((off) => off());
  }
}
