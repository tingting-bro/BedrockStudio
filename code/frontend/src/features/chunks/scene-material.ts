import * as THREE from "three";

/** Amulet emits atlas UVs directly, including partial/rotated model faces. */
export function amuletMaterials() {
  const materials = [
    new THREE.MeshBasicMaterial({ vertexColors: true, alphaTest: 0.02 }),
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      alphaTest: 0.02,
      side: THREE.DoubleSide,
    }),
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      alphaTest: 0.02,
      transparent: true,
      depthWrite: false,
    }),
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }),
  ];
  materials.forEach((material) => {
    material.toneMapped = false;
    // Amulet samples raw vanilla RGB and applies its tint/brightness directly.
    // The matching atlas uses NoColorSpace to avoid an extra gamma conversion.
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <colorspace_fragment>",
        "",
      );
    };
    material.customProgramCacheKey = () => "amulet-native-rgb-v1";
  });
  return materials;
}

/** Repeat within each padded atlas tile, including greedy rectangles. */
export function repeatAtlas<
  T extends THREE.MeshLambertMaterial | THREE.MeshBasicMaterial,
>(material: T, size: number): T {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.voxelTileScale = { value: 16 / size };
    shader.vertexShader =
      "attribute vec2 voxelTile;\nvarying vec2 vVoxelTile;\n" +
      shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nvVoxelTile = voxelTile;",
      );
    shader.fragmentShader =
      "varying vec2 vVoxelTile;\nuniform float voxelTileScale;\n" +
      shader.fragmentShader.replace(
        "#include <map_fragment>",
        THREE.ShaderChunk.map_fragment.replace(
          "texture2D( map, vMapUv )",
          "texture2D( map, vVoxelTile + fract( vMapUv ) * voxelTileScale )",
        ),
      );
  };
  material.customProgramCacheKey = () => "voxel-atlas-repeat-v1";
  return material;
}
