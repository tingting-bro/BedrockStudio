import * as THREE from "three";

export function selectionMaterial() {
  const highlight = { value: new THREE.Vector3() };
  const material = new THREE.MeshBasicMaterial({
    color: 0xb6e99b,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  material.userData.highlightNormal = highlight;
  material.customProgramCacheKey = () => "selection-unit-grid-v2";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.selectionHighlight = highlight;
    const declarations =
      "varying vec3 selectionPosition; varying vec3 selectionNormal;\n";
    shader.vertexShader =
      declarations +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nselectionPosition = (modelMatrix * vec4(position, 1.0)).xyz; selectionNormal = normal;",
      );
    shader.fragmentShader =
      "uniform vec3 selectionHighlight;\n" +
      declarations +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
      vec3 axis = abs(normalize(selectionNormal));
      vec2 cell = axis.y > 0.7 ? selectionPosition.xz : axis.x > 0.7 ? selectionPosition.yz : selectionPosition.xy;
      vec2 width = max(fwidth(cell), vec2(0.0001));
      vec2 grid = abs(fract(cell - 0.5) - 0.5) / width;
      float line = 1.0 - min(min(grid.x, grid.y), 1.0);
      diffuseColor.a = mix(0.07, 0.32, line);
      float hovered = step(0.95, dot(normalize(selectionNormal), selectionHighlight));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.68, 0.16), hovered);
      diffuseColor.a = mix(diffuseColor.a, mix(0.28, 0.65, line), hovered);`,
      );
  };
  return material;
}
