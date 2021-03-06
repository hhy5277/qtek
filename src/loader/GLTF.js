/**
 * glTF Loader
 * Specification https://github.com/KhronosGroup/glTF/blob/master/specification/README.md
 *
 * TODO https://github.com/KhronosGroup/glTF/issues/298
 */
define(function (require) {

    'use strict';

    var Base = require('../core/Base');
    var request = require('../core/request');
    var util = require('../core/util');
    var vendor = require('../core/vendor');

    var Scene = require('../Scene');
    var Shader = require('../Shader');
    var Material = require('../Material');
    var StandardMaterial = require('../StandardMaterial');
    var Mesh = require('../Mesh');
    var Node = require('../Node');
    var Texture = require('../Texture');
    var Texture2D = require('../Texture2D');
    var TextureCube = require('../TextureCube');
    var shaderLibrary = require('../shader/library');
    var Skeleton = require('../Skeleton');
    var Joint = require('../Joint');
    var PerspectiveCamera = require('../camera/Perspective');
    var OrthographicCamera = require('../camera/Orthographic');
    var PointLight = require('../light/Point');
    var SpotLight = require('../light/Spot');
    var DirectionalLight = require('../light/Directional');
    var glenum = require('../core/glenum');

    var Vector3 = require('../math/Vector3');
    var Quaternion = require('../math/Quaternion');
    var BoundingBox = require('../math/BoundingBox');

    var SamplerClip = require('../animation/SamplerClip');
    var SkinningClip = require('../animation/SkinningClip');

    var StaticGeometry = require('../StaticGeometry');

    var glMatrix = require('../dep/glmatrix');
    var quat = glMatrix.quat;

    // Import builtin shader
    require('../shader/builtin');

    var semanticAttributeMap = {
        'NORMAL': 'normal',
        'POSITION': 'position',
        'TEXCOORD_0': 'texcoord0',
        'TEXCOORD_1': 'texcoord1',
        'WEIGHT': 'weight',
        'JOINT': 'joint',
        'COLOR': 'color'
    };


    /**
     * @typedef {Object} qtek.loader.GLTF.IResult
     * @property {qtek.Scene} scene
     * @property {qtek.Node} rootNode
     * @property {Object.<string, qtek.Camera>} cameras
     * @property {Object.<string, qtek.Texture>} textures
     * @property {Object.<string, qtek.Material>} materials
     * @property {Object.<string, qtek.Skeleton>} skeletons
     * @property {Object.<string, qtek.Mesh>} meshes
     * @property {qtek.animation.SkinningClip} clip
     */

    /**
     * @constructor qtek.loader.GLTF
     * @extends qtek.core.Base
     */
    var GLTFLoader = Base.extend(
    /** @lends qtek.loader.GLTF# */
    {
        /**
         * @type {qtek.Node}
         */
        rootNode: null,
        /**
         * @type {string}
         */
        rootPath: null,

        /**
         * @type {string}
         */
        textureRootPath: null,

        /**
         * @type {string}
         */
        bufferRootPath: null,

        /**
         * @type {string}
         */
        shaderName: 'qtek.standard',

        /**
         * Cross origin setting
         */

        /**
         * @type {string}
         */
        useStandardMaterial: false,

        /**
         * @type {boolean}
         */
        includeCamera: true,

        /**
         * @type {boolean}
         */
        includeLight: true,

        /**
         * @type {boolean}
         */
        includeAnimation: true,
        /**
         * @type {boolean}
         */
        includeMesh: true,
        /**
         * @type {boolean}
         */
        includeTexture: true,

        /**
         * @type {string}
         */
        crossOrigin: ''
    },
    function () {
        this._shaderLib = shaderLibrary.createLibrary();
    },
    /** @lends qtek.loader.GLTF.prototype */
    {
        /**
         * @param  {string} url
         */
        load: function (url) {
            var self = this;

            if (this.rootPath == null) {
                this.rootPath = url.slice(0, url.lastIndexOf('/'));
            }

            request.get({
                url: url,
                onprogress: function (percent, loaded, total) {
                    self.trigger('progress', percent, loaded, total);
                },
                onerror: function (e) {
                    self.trigger('error', e);
                },
                responseType: 'text',
                onload: function (data) {
                    self.parse(JSON.parse(data));
                }
            });
        },

        /**
         * @param {Object} json
         * @return {qtek.loader.GLTF.IResult}
         */
        parse: function (json) {
            var self = this;
            var loading = 0;

            var lib = {
                buffers: {},
                materials: {},
                textures: {},
                meshes: {},
                joints: {},
                skeletons: {},
                cameras: {},
                nodes: {}
            };
            // Mount on the root node if given
            var rootNode = this.rootNode || new Scene();
            // Load buffers
            util.each(json.buffers, function (bufferInfo, name) {
                loading++;
                var path = bufferInfo.uri;

                // DEPRECATED compatible with older version(< 1.0)
                // https://github.com/KhronosGroup/glTF/wiki/glTF-0.8-to-1.0-Guide
                if (path == null) {
                    path = bufferInfo.path;
                }
                self._loadBuffer(path, function (buffer) {
                    lib.buffers[name] = buffer;
                    loading--;
                    if (loading === 0) {
                        afterLoadBuffer();
                    }
                }, function () {
                    loading--;
                    if (loading === 0) {
                        afterLoadBuffer();
                    }
                });
            });

            function afterLoadBuffer() {
                if (self.includeMesh) {
                    if (self.includeTexture) {
                        self._parseTextures(json, lib);
                    }
                    self._parseMaterials(json, lib);
                    self._parseMeshes(json, lib);
                }
                self._parseNodes(json, lib);

                var sceneInfo = json.scenes[json.scene];
                for (var i = 0; i < sceneInfo.nodes.length; i++) {
                    var node = lib.nodes[sceneInfo.nodes[i]];
                    node.update();
                    rootNode.add(node);
                }

                if (self.includeMesh) {
                    self._parseSkins(json, lib);
                }

                var clips = {};
                var skinningClip;
                if (self.includeAnimation) {
                    clips = self._parseAnimations(json, lib);
                    if (Object.keys(clips).length) {
                        skinningClip = new SkinningClip();
                        // Default loop the skinning animation
                        skinningClip.setLoop(true);
                        for (var targetId in clips) {
                            skinningClip.addJointClip(clips[targetId]);
                        }

                        for (var name in lib.skeletons) {
                            lib.skeletons[name].addClip(skinningClip);
                            lib.skeletons[name].relativeRootNode = rootNode;
                        }
                    }
                }

                self.trigger('success', {
                    scene: self.rootNode ? null : rootNode,
                    rootNode: self.rootNode ? rootNode : null,
                    cameras: lib.cameras,
                    textures: lib.textures,
                    materials: lib.materials,
                    skeletons: lib.skeletons,
                    meshes: lib.meshes,
                    clips: lib.clips,
                    // Main skinning clip
                    // TODO Skinning clip used for multiple skeleton ?
                    // TODO Some clip for individual node animations.
                    clip: skinningClip
                });
            }

            return {
                scene: self.rootNode ? null : rootNode,
                rootNode: self.rootNode ? rootNode : null,
                cameras: lib.cameras,
                textures: lib.textures,
                materials: lib.materials,
                skeletons: lib.skeletons,
                meshes: lib.meshes,
                clip: null
            };
        },

        _loadBuffer: function (path, onsuccess, onerror) {
            var rootPath = this.bufferRootPath;
            if (rootPath == null) {
                rootPath = this.rootPath;
            }
            if (rootPath) {
                path = rootPath + '/' + path;
            }
            request.get({
                url: path,
                responseType: 'arraybuffer',
                onload: function (buffer) {
                    onsuccess && onsuccess(buffer);
                },
                onerror: function (buffer) {
                    onerror && onerror(buffer);
                }
            });
        },

        // https://github.com/KhronosGroup/glTF/issues/100
        // https://github.com/KhronosGroup/glTF/issues/193
        _parseSkins: function (json, lib) {

            // Create skeletons and joints
            var haveInvBindMatrices = false;
            for (var name in json.skins) {
                var skinInfo = json.skins[name];
                var skeleton = new Skeleton({
                    name: name
                });
                for (var i = 0; i < skinInfo.joints.length; i++) {
                    var jointId = skinInfo.joints[i];
                    var joint = new Joint({
                        name: jointId,
                        index: skeleton.joints.length
                    });
                    skeleton.joints.push(joint);
                }
                if (skinInfo.inverseBindMatrices) {
                    haveInvBindMatrices = true;
                    var IBMInfo = skinInfo.inverseBindMatrices;
                    var bufferViewName = IBMInfo.bufferView;
                    var bufferViewInfo = json.bufferViews[bufferViewName];
                    var buffer = lib.buffers[bufferViewInfo.buffer];

                    var offset = IBMInfo.byteOffset + bufferViewInfo.byteOffset;
                    var size = IBMInfo.count * 16;

                    var array = new vendor.Float32Array(buffer, offset, size);

                    skeleton._invBindPoseMatricesArray = array;
                    skeleton._skinMatricesArray = new vendor.Float32Array(array.length);
                }
                lib.skeletons[name] = skeleton;
            }

            var bindNodeToJoint = function (jointsMap, nodeName, parentIndex, rootNode) {
                var node = lib.nodes[nodeName];
                var nodeInfo = json.nodes[nodeName];
                var joint = jointsMap[nodeInfo.jointId];
                if (joint) {
                    // throw new Error('Joint bind to ' + nodeInfo.name + ' doesn\'t exist in skin');
                    joint.node = node;
                    joint.parentIndex = parentIndex;
                    joint.rootNode = rootNode;
                    parentIndex = joint.index;
                }
                else {
                    // Some root node may be a simple transform joint, without deformation data.
                    // Which is, no vertex is attached to the joint
                    // PENDING
                    joint = new Joint({
                        node: node,
                        rootNode: rootNode,
                        parentIndex: parentIndex
                    });
                }

                for (var i = 0; i < nodeInfo.children.length; i++) {
                    bindNodeToJoint(jointsMap, nodeInfo.children[i], parentIndex, rootNode);
                }

                return joint;
            };

            var getJointIndex = function (joint) {
                return joint.index;
            };

            var instanceSkins = {};

            var shaderLib = this._shaderLib;
            var shaderName = this.shaderName;
            function enableSkinningForMesh(mesh, skeleton, jointIndices) {
                mesh.skeleton = skeleton;
                mesh.joints = jointIndices;
                // Make sure meshs with different joints not have same material.
                var originalShader = mesh.material.shader;
                var material = mesh.material.clone();
                mesh.material = material;
                if (material instanceof StandardMaterial) {
                    material.jointCount = jointIndices.length;
                }
                else {
                    material.shader = shaderLib.get(
                        shaderName, {
                            textures: originalShader.getEnabledTextures(),
                            vertexDefines: {
                                SKINNING: null,
                                JOINT_COUNT: jointIndices.length
                            }
                        }
                    );
                }
            }

            for (var name in json.nodes) {

                var nodeInfo = json.nodes[name];

                if (nodeInfo.instanceSkin) {
                    var skinName = nodeInfo.instanceSkin.skin;
                    var skeleton = lib.skeletons[skinName];
                    instanceSkins[skinName] = skeleton;

                    var node = lib.nodes[name];
                    var jointIndices = skeleton.joints.map(getJointIndex);
                    if (node instanceof Mesh) {
                        enableSkinningForMesh(node, skeleton, jointIndices);
                    }
                    else {
                        // Mesh have multiple primitives
                        for (var i = 0; i < node._children.length; i++) {
                            enableSkinningForMesh(node._children[i], skeleton, jointIndices);
                        }
                    }

                    var jointsMap = {};
                    for (var i = 0; i < skeleton.joints.length; i++) {
                        var joint = skeleton.joints[i];
                        jointsMap[joint.name] = joint;
                    }
                    // Build up hierarchy from root nodes
                    var rootNodes = nodeInfo.instanceSkin.skeletons;
                    for (i = 0; i < rootNodes.length; i++) {
                        var rootNode = lib.nodes[rootNodes[i]];
                        var rootJoint = bindNodeToJoint(jointsMap, rootNodes[i], -1, rootNode);
                        // Root joint may not in the skeleton
                        if (rootJoint) {
                            skeleton.roots.push(rootJoint);
                        }
                    }
                }
            }

            for (var name in instanceSkins) {
                var skeleton = instanceSkins[name];
                if (haveInvBindMatrices) {
                    skeleton.updateMatricesSubArrays();
                }
                else {
                    skeleton.updateJointMatrices();
                }
                skeleton.update();
            }
        },

        _parseTextures: function (json, lib) {
            var rootPath = this.textureRootPath;
            if (rootPath == null) {
                rootPath = this.rootPath;
            }
            util.each(json.textures, function (textureInfo, name){
                var samplerInfo = json.samplers[textureInfo.sampler];
                var parameters = {};
                ['wrapS', 'wrapT', 'magFilter', 'minFilter']
                .forEach(function (name) {
                    var value = samplerInfo[name];
                    if (value != null) {
                        if (typeof(value) === 'string') {
                            // DEPRECATED, sampler parameter now use gl enum instead of string
                            value = glenum[value];
                        }
                        parameters[name] = value;
                    }
                });

                var target = textureInfo.target;
                var format = textureInfo.format;
                if (typeof(target) === 'string') {
                    // DEPRECATED
                    target = glenum[target];
                    format = glenum[format];
                }
                parameters.format = format;

                if (target === glenum.TEXTURE_2D) {
                    var texture = new Texture2D(parameters);
                    var imageInfo = json.images[textureInfo.source];
                    texture.load(util.relative2absolute(imageInfo.path, rootPath), this.crossOrigin);
                    lib.textures[name] = texture;
                }
                else if(target === glenum.TEXTURE_CUBE_MAP) {
                    // TODO
                }
            }, this);
        },

        // Only phong material is support yet
        // TODO support custom material
        _parseMaterials: function (json, lib) {
            var techniques = {};
            // Parse techniques
            for (var name in json.techniques) {
                var techniqueInfo = json.techniques[name];

                // DEPRECATED compatible with older version(< 1.0)
                // There are no passes in techniques now
                // https://github.com/KhronosGroup/glTF/wiki/glTF-0.8-to-1.0-Guide
                if (techniqueInfo.passes) {
                    techniques[name] = techniqueInfo.passes[techniqueInfo.pass];
                }
                else {
                    techniques[name] = techniqueInfo;
                }
            }
            for (var name in json.materials) {
                var materialInfo = json.materials[name];

                // DEPRECATED compatible with older version(< 1.0)
                // There no instanceTechnique in material now.
                // https://github.com/KhronosGroup/glTF/wiki/glTF-0.8-to-1.0-Guide
                if (materialInfo.instanceTechnique) {
                    for (var key in materialInfo.instanceTechnique) {
                        materialInfo[key] = materialInfo.instanceTechnique[key];
                    }
                    materialInfo.instanceTechnique = null;
                }
                var technique = techniques[materialInfo.technique];
                var uniforms = {};

                uniforms = materialInfo.values;
                for (var symbol in uniforms) {
                    var value = uniforms[symbol];
                    // TODO: texture judgement should be more robust
                    if (typeof(value) === 'string') {
                        if (lib.textures[value]) {
                            uniforms[symbol] = lib.textures[value];
                        }
                        else {
                            uniforms[symbol] = null;
                        }
                    }
                }
                var enabledTextures = [];
                if (uniforms['diffuse'] instanceof Texture2D) {
                    enabledTextures.push('diffuseMap');
                }
                if (uniforms['normalMap'] instanceof Texture2D) {
                    enabledTextures.push('normalMap');
                }
                var material;
                var isStandardMaterial = this.useStandardMaterial;
                if (isStandardMaterial) {
                    material = new StandardMaterial({
                        name: materialInfo.name
                    });
                }
                else {
                    material = new Material({
                        name: materialInfo.name,
                        shader: this._shaderLib.get(this.shaderName, enabledTextures)
                    });
                }
                if (technique.states.depthMask != null) {
                    material.depthMask = technique.states.depthMask;
                }
                if (technique.states.depthTestEnable != null) {
                    material.depthTest = technique.states.depthTestEnable;
                }
                material.cullFace = technique.states.cullFaceEnable || false;
                if (technique.states.blendEnable) {
                    material.transparent = true;
                    // TODO blend Func and blend Equation
                }

                var diffuseProp = uniforms['diffuse'];
                if (diffuseProp) {
                    // Color
                    if (diffuseProp instanceof Array) {
                        if (isStandardMaterial) {
                            material.color = diffuseProp.slice(0, 3);
                        }
                        else {
                            material.set('color', diffuseProp.slice(0, 3));
                        }
                    }
                    else { // Texture
                        if (isStandardMaterial) {
                            material.diffuseMap = diffuseProp;
                        }
                        else {
                            material.set('diffuseMap', diffuseProp);
                        }
                    }
                }
                if (uniforms['normalMap'] != null) {
                    if (isStandardMaterial) {
                        material.normalMap = uniforms['normalMap'];
                    }
                    else {
                        material.set('normalMap', uniforms['normalMap']);
                    }
                }
                if (uniforms['emission'] != null) {
                    material.set('emission', uniforms['emission'].slice(0, 3));
                }
                if (uniforms['shininess'] != null) {
                    var glossiness = Math.log(uniforms['shininess']) / Math.log(8192);
                    // Uniform glossiness
                    material.set('glossiness', glossiness);
                    material.set('roughness', 1 - glossiness);
                    material.set('shininess', uniforms['shininess']);
                }
                else {
                    material.set('glossiness', 0.5);
                    material.set('shininess', 0.5);
                }
                if (uniforms['specular'] != null) {
                    material.set('specularColor', uniforms['specular'].slice(0, 3));
                }
                if (uniforms['transparency'] != null) {
                    material.set('alpha', uniforms['transparency']);
                }

                lib.materials[name] = material;
            }
        },

        _parseMeshes: function (json, lib) {
            var self = this;

            var meshKeys = Object.keys(json.meshes);
            for (var nn = 0; nn < meshKeys.length; nn++) {
                var name = meshKeys[nn];
                var meshInfo = json.meshes[name];

                lib.meshes[name] = [];
                // Geometry
                for (var pp = 0; pp < meshInfo.primitives.length; pp++) {
                    var primitiveInfo = meshInfo.primitives[pp];
                    var geometry = new StaticGeometry({
                        boundingBox: new BoundingBox()
                    });
                    // Parse attributes
                    var semantics = Object.keys(primitiveInfo.attributes);
                    for (var ss = 0; ss < semantics.length; ss++) {
                        var semantic = semantics[ss];
                        var accessorName = primitiveInfo.attributes[semantic];
                        var attributeInfo = json.accessors[accessorName];
                        var attributeName = semanticAttributeMap[semantic];
                        if (!attributeName) {
                            continue;
                        }
                        var componentType = attributeInfo.componentType;
                        // DEPRECATED compatible with older version(< 1.0)
                        if (componentType == null) {
                            var attributeType = attributeInfo.type;
                            switch(attributeType) {
                                case 0x8B50:     // FLOAT_VEC2
                                    size = 2;
                                    ArrayCtor = vendor.Float32Array;
                                    break;
                                case 0x8B51:     // FLOAT_VEC3
                                    size = 3;
                                    ArrayCtor = vendor.Float32Array;
                                    break;
                                case 0x8B52:     // FLOAT_VEC4
                                    size = 4;
                                    ArrayCtor = vendor.Float32Array;
                                    break;
                                case 0x1406:     // FLOAT
                                    size = 1;
                                    ArrayCtor = vendor.Float32Array;
                                    break;
                                default:
                                    console.warn('Attribute type ' + attributeInfo.type + ' not support yet');
                                    break;
                            }
                        }
                        else {
                            var attributeType = attributeInfo.type;
                            ArrayCtor = ({
                                5120: vendor.Int8Array,
                                5121: vendor.Uint8Array,
                                5122: vendor.Int16Array,
                                5123: vendor.Uint16Array,
                                5126: vendor.Float32Array
                            })[componentType] || vendor.Float32Array;

                            size = ({
                                SCALAR: 1,
                                VEC2: 2,
                                VEC3: 3,
                                VEC4: 4,
                                MAT2: 4,
                                MAT3: 9,
                                MAT4: 16
                            })[attributeType];
                        }

                        var bufferViewInfo = json.bufferViews[attributeInfo.bufferView];
                        var buffer = lib.buffers[bufferViewInfo.buffer];
                        var byteOffset = bufferViewInfo.byteOffset + attributeInfo.byteOffset;

                        var size;
                        var ArrayCtor;
                        var attributeArray = new ArrayCtor(buffer, byteOffset, attributeInfo.count * size);
                        if (semantic === 'WEIGHT' && size === 4) {
                            // Weight data in QTEK has only 3 component, the last component can be evaluated since it is normalized
                            var weightArray = new ArrayCtor(attributeInfo.count * 3);
                            for (var i = 0; i < attributeInfo.count; i++) {
                                weightArray[i * 3] = attributeArray[i * 4];
                                weightArray[i * 3 + 1] = attributeArray[i * 4 + 1];
                                weightArray[i * 3 + 2] = attributeArray[i * 4 + 2];
                            }
                            geometry.attributes[attributeName].value = weightArray;
                        }
                        else {
                            geometry.attributes[attributeName].value = attributeArray;
                        }
                        if (semantic === 'POSITION') {
                            // Bounding Box
                            var min = attributeInfo.min;
                            var max = attributeInfo.max;
                            if (min) {
                                geometry.boundingBox.min.set(min[0], min[1], min[2]);
                            }
                            if (max) {
                                geometry.boundingBox.max.set(max[0], max[1], max[2]);
                            }
                        }
                    }

                    // Parse indices
                    var indicesInfo = json.accessors[primitiveInfo.indices];

                    var bufferViewInfo = json.bufferViews[indicesInfo.bufferView];
                    var buffer = lib.buffers[bufferViewInfo.buffer];
                    var byteOffset = bufferViewInfo.byteOffset + indicesInfo.byteOffset;

                    // index uint
                    if (indicesInfo.componentType === 0x1405) { // UNSIGNED_INT
                        geometry.indices = new vendor.Uint32Array(buffer, byteOffset, indicesInfo.count);
                    }
                    else { // UNSIGNED_SHORT, 0x1403
                        geometry.indices = new vendor.Uint16Array(buffer, byteOffset, indicesInfo.count);
                    }

                    var material = lib.materials[primitiveInfo.material];
                    //Collada export from blender may not have default material
                    if (!material) {
                        material = new Material({
                            shader: this._shaderLib.get(self.shaderName)
                        });
                    }
                    var mesh = new Mesh({
                        geometry: geometry,
                        material: material
                    });
                    if (material.shader.isTextureEnabled('normalMap')) {
                        if (!mesh.geometry.attributes.tangent.value) {
                            mesh.geometry.generateTangents();
                        }
                    }

                    if (meshInfo.name) {
                        if (meshInfo.primitives.length > 1) {
                            mesh.name = [meshInfo.name, pp].join('-');
                        }
                        else {
                            // PENDING name or meshInfo.name ?
                            mesh.name = meshInfo.name;
                        }
                    }

                    lib.meshes[name].push(mesh);
                }
            }
        },

        _parseNodes: function (json, lib) {

            for (var name in json.nodes) {
                var nodeInfo = json.nodes[name];
                var node;
                if (nodeInfo.camera && this.includeCamera) {
                    var cameraInfo = json.cameras[nodeInfo.camera];

                    if (cameraInfo.projection === 'perspective') {
                        node = new PerspectiveCamera({
                            name: nodeInfo.name,
                            aspect: cameraInfo.aspect_ratio,
                            fov: cameraInfo.xfov,
                            far: cameraInfo.zfar,
                            near: cameraInfo.znear
                        });
                    }
                    else {
                        // TODO
                        node = new OrthographicCamera();
                        console.warn('TODO:Orthographic camera');
                    }
                    node.setName(nodeInfo.name);
                    lib.cameras[nodeInfo.name] = node;
                }
                else if (nodeInfo.lights && this.includeLight) {
                    var lights = [];
                    for (var i = 0; i < nodeInfo.lights.length; i++) {
                        var lightInfo = json.lights[nodeInfo.lights[i]];
                        var light = this._parseLight(lightInfo);
                        if (light) {
                            lights.push(light);
                        }
                    }
                    if (lights.length == 1) {
                        // Replace the node with light
                        node = lights[0];
                        node.setName(nodeInfo.name);
                    }
                    else {
                        node = new Node();
                        node.setName(nodeInfo.name);
                        for (var i = 0; i < lights.length; i++) {
                            node.add(lights[i]);
                        }
                    }
                }
                else if ((nodeInfo.meshes || nodeInfo.instanceSkin) && this.includeMesh) {
                    // TODO one node have multiple meshes ?
                    var meshKey;
                    if (nodeInfo.meshes) {
                        meshKey = nodeInfo.meshes[0];
                    }
                    else {
                        meshKey = nodeInfo.instanceSkin.sources[0];
                    }
                    if (meshKey) {
                        var primitives = lib.meshes[meshKey];
                        if (primitives) {
                            if (primitives.length === 1) {
                                // Replace the node with mesh directly
                                node = primitives[0];
                                node.setName(nodeInfo.name);
                            }
                            else {
                                node = new Node();
                                node.setName(nodeInfo.name);
                                for (var j = 0; j < primitives.length; j++) {
                                    if (nodeInfo.instanceSkin) {
                                        primitives[j].skeleton = nodeInfo.instanceSkin.skin;
                                    }
                                    node.add(primitives[j]);
                                }
                            }
                        }
                    }
                }
                else {
                    node = new Node();
                    node.setName(nodeInfo.name);
                }
                if (nodeInfo.matrix) {
                    node.localTransform.setArray(nodeInfo.matrix);
                    node.decomposeLocalTransform();
                }
                else {
                    if (nodeInfo.translation) {
                        node.position.setArray(nodeInfo.translation);
                    }
                    if (nodeInfo.rotation) {
                        // glTF use axis angle in rotation
                        // https://github.com/KhronosGroup/glTF/issues/144
                        // quat.setAxisAngle(node.rotation._array, nodeInfo.rotation.slice(0, 3), nodeInfo.rotation[3]);
                        // node.rotation._dirty = true;

                        // https://github.com/KhronosGroup/glTF/wiki/glTF-0.8-to-1.0-Guide
                        // From 1.0 rotation use quaternion instead
                        node.rotation.setArray(nodeInfo.rotation);
                    }
                    if (nodeInfo.scale) {
                        node.scale.setArray(nodeInfo.scale);
                    }
                }

                lib.nodes[name] = node;
            }

            // Build hierarchy
            for (var name in json.nodes) {
                var nodeInfo = json.nodes[name];
                var node = lib.nodes[name];
                if (nodeInfo.children) {
                    for (var i = 0; i < nodeInfo.children.length; i++) {
                        var childName = nodeInfo.children[i];
                        var child = lib.nodes[childName];
                        node.add(child);
                    }
                }
            }
         },

        _parseLight: function (lightInfo) {
            // TODO Light parameters
            switch(lightInfo.type) {
                case 'point':
                    var light = new PointLight({
                        name: lightInfo.id,
                        color: lightInfo.point.color,
                    });
                    break;
                case 'spot':
                    var light = new SpotLight({
                        name: lightInfo.id,
                        color: lightInfo.spot.color
                    });
                    break;
                case 'directional':
                    var light = new DirectionalLight({
                        name: lightInfo.id,
                        color: lightInfo.directional.color
                    });
                    break;
                default:
                    console.warn('Light ' + lightInfo.type + ' not support yet');
            }

            return light;
        },

        _parseAnimations: function (json, lib) {
            // TODO Only support nodes animation now

            var nodeAnimationClips = lib.clips = {};

            var quatTmp = quat.create();

            for (var animName in json.animations) {
                var animationInfo = json.animations[animName];
                var parameters = {};

                for (var paramName in animationInfo.parameters) {
                    var accessorName = animationInfo.parameters[paramName];
                    var accessorInfo = json.accessors[accessorName];

                    var bufferViewInfo = json.bufferViews[accessorInfo.bufferView];
                    var buffer = lib.buffers[bufferViewInfo.buffer];
                    var byteOffset = bufferViewInfo.byteOffset + accessorInfo.byteOffset;
                    switch(accessorInfo.type) {
                        case 0x8B50:     // FLOAT_VEC2
                            var size = 2;
                            break;
                        case 0x8B51:     // FLOAT_VEC3
                            var size = 3;
                            break;
                        case 0x8B52:     // FLOAT_VEC4
                            var size = 4;
                            break;
                        case 0x1406:     // FLOAT
                            var size = 1;
                            break;
                    }
                    parameters[paramName] = new vendor.Float32Array(buffer, byteOffset, size * accessorInfo.count);
                }

                if (!parameters.TIME || !animationInfo.channels.length) {
                    continue;
                }

                // Use the first channels target
                var targetId = animationInfo.channels[0].target.id;
                var targetNode = lib.nodes[targetId];

                // glTF use axis angle in rotation, convert to quaternion
                // https://github.com/KhronosGroup/glTF/issues/144
                var rotationArr = parameters.rotation;
                if (rotationArr) {
                    for (var i = 0; i < parameters.TIME.length; i++) {
                        parameters.TIME[i] *= 1000;
                        var offset = i * 4;
                        if (rotationArr) {
                            quatTmp[0] = rotationArr[offset];
                            quatTmp[1] = rotationArr[offset + 1];
                            quatTmp[2] = rotationArr[offset + 2];
                            quat.setAxisAngle(quatTmp, quatTmp, rotationArr[offset + 3]);
                            parameters.rotation[offset] = quatTmp[0];
                            parameters.rotation[offset + 1] = quatTmp[1];
                            parameters.rotation[offset + 2] = quatTmp[2];
                            parameters.rotation[offset + 3] = quatTmp[3];
                        }
                    }
                }

                // TODO
                // if (nodeAnimationClips[targetId]) {
                //     continue;
                // }
                nodeAnimationClips[targetId] = new SamplerClip({
                    name: targetNode.name,
                    target: targetNode
                });
                var nodeAnimationClip = nodeAnimationClips[targetId];
                nodeAnimationClip.channels.time = parameters.TIME;
                nodeAnimationClip.channels.rotation = parameters.rotation || null;
                nodeAnimationClip.channels.position = parameters.translation || null;
                nodeAnimationClip.channels.scale = parameters.scale || null;
                nodeAnimationClip.life = parameters.TIME[parameters.TIME.length - 1];
            }

            return nodeAnimationClips;
        }
    });

    return GLTFLoader;
});