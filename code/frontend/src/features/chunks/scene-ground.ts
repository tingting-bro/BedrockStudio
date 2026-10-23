import * as THREE from "three";
import { dimensionHeight } from "./scene-chunks";

/** A display-only floor below the dimension, never a voxel picking target. */
export class SceneGround {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.PlaneGeometry(1, 1);
  private material = new THREE.ShaderMaterial({
    uniforms: {
      extent: { value: 1 },
      offset: { value: new THREE.Vector2() },
    },
    vertexShader: `
      varying vec2 groundPosition;
      uniform float extent;
      uniform vec2 offset;
      void main() {
        groundPosition = position.xy * extent + offset;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 groundPosition;
      void main() {
        float tile = mod(floor(groundPosition.x / 16.0) + floor(-groundPosition.y / 16.0), 2.0);
        gl_FragColor = vec4(mix(vec3(80.0, 85.0, 93.0), vec3(62.0, 67.0, 75.0), tile) / 255.0, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    // Background layers must not compete for precision with each other or terrain.
    depthTest: false,
    depthWrite: false,
  });
  constructor() {
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.name = "dimension-checker-ground";
    this.mesh.renderOrder = -2;
  }
  update(
    x: number,
    z: number,
    radius: number,
    dimension: number,
    ox: number,
    oz: number,
  ) {
    const cx = Math.floor(x / 16) * 16 + 8;
    const cz = Math.floor(z / 16) * 16 + 8;
    const extent = (2 * radius + 1) * 16;
    this.mesh.scale.set(extent, extent, 1);
    this.mesh.position.set(
      cx - ox,
      dimensionHeight(dimension)[0] - 0.05,
      cz - oz,
    );
    this.material.uniforms.extent.value = extent;
    // Plane-local Y points towards -Z after rotation; retain world tile parity
    // across negative coordinates, movement, and floating-origin rebases.
    this.material.uniforms.offset.value.set(cx % 32, -cz % 32);
  }
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
