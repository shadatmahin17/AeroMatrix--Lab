import * as THREE from 'three';
import { HitPointInfo, MeshBVH } from 'three-mesh-bvh';
import type { AircraftSurfaceField, SurfaceSample } from './AircraftSurfaceField';

export interface ColliderPoint {
  x: number;
  y: number;
  z: number;
}

export interface ColliderVelocity {
  u: number;
  v: number;
  w: number;
}

// Pre-allocated scratch buffers so 60fps RK2 advection sub-steps allocate zero heap objects
const _queryPt = new THREE.Vector3();
const _hit: HitPointInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _tri = new THREE.Triangle();
const _faceNormal = new THREE.Vector3();
const _diff = new THREE.Vector3();
const _sfNormal = new THREE.Vector3();
const _sfSample: SurfaceSample = { dist: 0, nx: 0, ny: 1, nz: 0, inside: false };

/**
 * Triangle-accurate `three-mesh-bvh` collider in body-local space.
 * Provides fast `closestPointToPoint` queries and smooth no-penetration
 * tangential deflection (`V_tan = V - (V · n)n`) for arbitrary meshes
 * (cylinders, airfoils, spheres, aircraft, and custom `.glb` models).
 */
export class MeshBvhCollider {
  public readonly bvh: MeshBVH;
  public readonly geometry: THREE.BufferGeometry;
  public readonly boundingBox: THREE.Box3;

  private readonly posAttr: THREE.BufferAttribute;
  private readonly idxAttr: THREE.BufferAttribute | null;
  private readonly minX: number;
  private readonly minY: number;
  private readonly minZ: number;
  private readonly maxX: number;
  private readonly maxY: number;
  private readonly maxZ: number;

  private constructor(
    bvh: MeshBVH,
    geometry: THREE.BufferGeometry,
    boundingBox: THREE.Box3
  ) {
    this.bvh = bvh;
    this.geometry = geometry;
    this.boundingBox = boundingBox.clone();
    this.posAttr = geometry.attributes.position as THREE.BufferAttribute;
    this.idxAttr = geometry.index ? (geometry.index as THREE.BufferAttribute) : null;
    this.minX = this.boundingBox.min.x;
    this.minY = this.boundingBox.min.y;
    this.minZ = this.boundingBox.min.z;
    this.maxX = this.boundingBox.max.x;
    this.maxY = this.boundingBox.max.y;
    this.maxZ = this.boundingBox.max.z;
  }

  /**
   * Builds a single merged body-space `MeshBVH` from any Three.js object hierarchy.
   * Passing `referenceParent` expresses all mesh vertices in `referenceParent` local space
   * (e.g., `aircraftGroup` before AoA rotation).
   */
  public static fromThreeGroup(
    root: THREE.Object3D,
    referenceParent?: THREE.Object3D | null
  ): MeshBvhCollider | null {
    root.updateMatrixWorld(true);
    const invRef = new THREE.Matrix4();
    if (referenceParent) {
      referenceParent.updateMatrixWorld(true);
      invRef.copy(referenceParent.matrixWorld).invert();
    } else {
      invRef.identity();
    }

    const meshes: THREE.Mesh[] = [];
    let totalVerts = 0;

    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || !mesh.geometry.attributes?.position) return;
      const geo = mesh.geometry;
      const idx = geo.index;
      const triVerts = idx ? idx.count : geo.attributes.position.count;
      const usable = Math.floor(triVerts / 3) * 3;
      if (usable >= 3) {
        meshes.push(mesh);
        totalVerts += usable;
      }
    });

    if (totalVerts < 3) return null;

    const mergedPositions = new Float32Array(totalVerts * 3);
    const relMat = new THREE.Matrix4();
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    let offset = 0;

    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      relMat.multiplyMatrices(invRef, mesh.matrixWorld);
      const flipWinding = relMat.determinant() < 0;

      const count = idx ? Math.floor(idx.count / 3) * 3 : Math.floor(pos.count / 3) * 3;
      for (let i = 0; i < count; i += 3) {
        const i0 = idx ? idx.getX(i) : i;
        const i1 = idx ? idx.getX(i + 1) : i + 1;
        const i2 = idx ? idx.getX(i + 2) : i + 2;

        v0.fromBufferAttribute(pos, i0).applyMatrix4(relMat);
        v1.fromBufferAttribute(pos, i1).applyMatrix4(relMat);
        v2.fromBufferAttribute(pos, i2).applyMatrix4(relMat);

        if (
          !Number.isFinite(v0.x) ||
          !Number.isFinite(v1.x) ||
          !Number.isFinite(v2.x)
        ) {
          continue;
        }

        mergedPositions[offset++] = v0.x;
        mergedPositions[offset++] = v0.y;
        mergedPositions[offset++] = v0.z;

        if (flipWinding) {
          mergedPositions[offset++] = v2.x;
          mergedPositions[offset++] = v2.y;
          mergedPositions[offset++] = v2.z;
          mergedPositions[offset++] = v1.x;
          mergedPositions[offset++] = v1.y;
          mergedPositions[offset++] = v1.z;
        } else {
          mergedPositions[offset++] = v1.x;
          mergedPositions[offset++] = v1.y;
          mergedPositions[offset++] = v1.z;
          mergedPositions[offset++] = v2.x;
          mergedPositions[offset++] = v2.y;
          mergedPositions[offset++] = v2.z;
        }
      }
    }

    if (offset < 9) return null;

    const finalPositions =
      offset === mergedPositions.length ? mergedPositions : mergedPositions.subarray(0, offset);
    const mergedGeo = new THREE.BufferGeometry();
    mergedGeo.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
    mergedGeo.computeBoundingBox();

    const bvh = new MeshBVH(mergedGeo, { targetLeafSize: 10 });
    mergedGeo.boundsTree = bvh;
    return new MeshBvhCollider(bvh, mergedGeo, mergedGeo.boundingBox ?? new THREE.Box3());
  }

  /**
   * Builds a collider directly from a single `BufferGeometry` in body space.
   */
  public static fromGeometry(geometry: THREE.BufferGeometry): MeshBvhCollider | null {
    const mesh = new THREE.Mesh(geometry);
    return MeshBvhCollider.fromThreeGroup(mesh);
  }

  private readFaceNormal(faceIndex: number, outNormal: THREE.Vector3): boolean {
    const base = faceIndex * 3;
    const i0 = this.idxAttr ? this.idxAttr.getX(base) : base;
    const i1 = this.idxAttr ? this.idxAttr.getX(base + 1) : base + 1;
    const i2 = this.idxAttr ? this.idxAttr.getX(base + 2) : base + 2;

    if (i2 >= this.posAttr.count) return false;
    _vA.fromBufferAttribute(this.posAttr, i0);
    _vB.fromBufferAttribute(this.posAttr, i1);
    _vC.fromBufferAttribute(this.posAttr, i2);
    _tri.set(_vA, _vB, _vC).getNormal(outNormal);
    return outNormal.lengthSq() > 1e-10;
  }

  /**
   * Fast AABB + BVH check whether body-space point `(bx, by, bz)` lies inside the mesh
   * or closer than `clearance`.
   */
  public isPointInsideOrNear(
    bx: number,
    by: number,
    bz: number,
    clearance: number,
    sf?: AircraftSurfaceField | null
  ): boolean {
    if (
      bx < this.minX - clearance ||
      bx > this.maxX + clearance ||
      by < this.minY - clearance ||
      by > this.maxY + clearance ||
      bz < this.minZ - clearance ||
      bz > this.maxZ + clearance
    ) {
      return false;
    }

    if (sf && sf.sample(bx, by, bz, _sfSample) && _sfSample.dist < clearance) {
      return true;
    }

    const hit = this.bvh.closestPointToPoint(_queryPt.set(bx, by, bz), _hit, 0, clearance);
    if (hit !== null) {
      return true;
    }

    // Check interior containment via BVH closest surface orientation even when far from surface
    const deepHit = this.bvh.closestPointToPoint(_queryPt.set(bx, by, bz), _hit);
    if (deepHit !== null && this.readFaceNormal(deepHit.faceIndex, _faceNormal)) {
      _diff.subVectors(_queryPt, deepHit.point);
      if (_diff.dot(_faceNormal) < -1e-4) {
        return true;
      }
    }

    return false;
  }

  /**
   * Queries `MeshBVH.closestPointToPoint` in body space. If the world-space point `pos`
   * enters the solid mesh or clearance shell (`distance < clearance`), pushes `pos` out
   * along the outward surface normal and projects out any inward normal velocity component:
   * `V_tan = V - (V · n)n`.
   */
  public deflectWorldPointAndVelocity(
    pos: ColliderPoint,
    vel: ColliderVelocity | null,
    aoaDeg: number,
    clearance: number,
    sf?: AircraftSurfaceField | null
  ): boolean {
    const aoaRad = (aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    const bx = pos.x * cosA - pos.y * sinA;
    const by = pos.x * sinA + pos.y * cosA;
    const bz = pos.z;

    const searchMax = clearance * 1.5;
    if (
      bx < this.minX - searchMax ||
      bx > this.maxX + searchMax ||
      by < this.minY - searchMax ||
      by > this.maxY + searchMax ||
      bz < this.minZ - searchMax ||
      bz > this.maxZ + searchMax
    ) {
      return false;
    }

    const hasSf = sf ? sf.sample(bx, by, bz, _sfSample) : false;
    let hit = this.bvh.closestPointToPoint(_queryPt.set(bx, by, bz), _hit, 0, searchMax);

    // If inside a thick body deeper than `searchMax`, query unconstrained closest surface point
    if (!hit && hasSf && _sfSample.dist < 0) {
      hit = this.bvh.closestPointToPoint(_queryPt.set(bx, by, bz), _hit);
    }

    if (!hit) {
      return false;
    }

    const hasFaceNormal = this.readFaceNormal(hit.faceIndex, _faceNormal);
    _diff.subVectors(_queryPt, hit.point);

    let isInside = hasSf && _sfSample.dist < 0;
    if (!isInside && hasFaceNormal && hit.distance > 1e-5 && _diff.dot(_faceNormal) < -1e-4) {
      // For unclosed/double-sided GLB wings, trust SDF exterior classification if clearly outside
      if (!hasSf || _sfSample.dist <= clearance * 0.9) {
        isInside = true;
      }
    }

    if (!isInside && hit.distance >= clearance) {
      return false;
    }

    // Resolve consistent outward body-space normal (nbx, nby, nbz)
    let nbx = 0;
    let nby = 1;
    let nbz = 0;

    if (hasFaceNormal) {
      nbx = _faceNormal.x;
      nby = _faceNormal.y;
      nbz = _faceNormal.z;
      if (hasSf) {
        _sfNormal.set(_sfSample.nx, _sfSample.ny, _sfSample.nz);
        if (_sfNormal.lengthSq() > 0.25 && _faceNormal.dot(_sfNormal) < 0) {
          nbx = -nbx;
          nby = -nby;
          nbz = -nbz;
        }
      } else if (!isInside && hit.distance > 1e-5 && _diff.dot(_faceNormal) < 0) {
        // Double-sided surface approached from back-face side while outside
        nbx = -nbx;
        nby = -nby;
        nbz = -nbz;
      }
    } else if (hit.distance > 1e-5) {
      const invD = 1 / hit.distance;
      nbx = _diff.x * invD * (isInside ? -1 : 1);
      nby = _diff.y * invD * (isInside ? -1 : 1);
      nbz = _diff.z * invD * (isInside ? -1 : 1);
    } else if (hasSf) {
      nbx = _sfSample.nx;
      nby = _sfSample.ny;
      nbz = _sfSample.nz;
    }

    // When strictly outside the mesh, blend toward radial separation vector `bp - hit.point`
    // so sharp trailing edges and convex corners push smoothly without grazing discontinuities
    if (!isInside && hit.distance > 1e-4) {
      const invD = 1 / hit.distance;
      const rx = _diff.x * invD;
      const ry = _diff.y * invD;
      const rz = _diff.z * invD;
      if (rx * nbx + ry * nby + rz * nbz > 0) {
        nbx = rx;
        nby = ry;
        nbz = rz;
      }
    }

    const nLen = Math.hypot(nbx, nby, nbz);
    if (nLen > 1e-6) {
      nbx /= nLen;
      nby /= nLen;
      nbz /= nLen;
    } else {
      nbx = 0;
      nby = 1;
      nbz = 0;
    }

    // Push particle out along surface normal to clearance shell
    const targetDist = clearance + 0.008;
    const outBx = hit.point.x + nbx * targetDist;
    const outBy = hit.point.y + nby * targetDist;
    const outBz = hit.point.z + nbz * targetDist;

    pos.x = outBx * cosA + outBy * sinA;
    pos.y = -outBx * sinA + outBy * cosA;
    pos.z = outBz;

    // Project out inward normal velocity: V_tan = V - (V · n)n
    if (vel) {
      const wnx = nbx * cosA + nby * sinA;
      const wny = -nbx * sinA + nby * cosA;
      const wnz = nbz;
      const vDotN = vel.u * wnx + vel.v * wny + vel.w * wnz;
      if (vDotN < 0) {
        vel.u -= vDotN * wnx;
        vel.v -= vDotN * wny;
        vel.w -= vDotN * wnz;
      }
    }

    return true;
  }

  public dispose(): void {
    this.geometry.boundsTree = undefined;
    this.geometry.dispose();
  }
}
