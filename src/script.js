import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import positionFragmentShader from './shaders/particles/fragmentShaderPosition.glsl'
import velocityFragmentShader from './shaders/particles/fragmentShaderVelocity.glsl'

/* TEXTURE WIDTH FOR SIMULATION */
const WIDTH = 64;
const BIRDS = WIDTH * WIDTH;

/* BAKE ANIMATION INTO TEXTURE and CREATE GEOMETRY FROM BASE MODEL */
const BirdGeometry = new THREE.BufferGeometry();
let textureAnimation, durationAnimation, birdMesh, materialShader, indicesPerBird;

// Load model data
const gltfs = './model/Parrot.glb';
const colors =  0xccFFFF ;
const sizes = 0.2;

new GLTFLoader().load( gltfs, function ( gltf ) {

    const animations = gltf.animations;
    durationAnimation = Math.round( animations[ 0 ].duration * 60 );
    const birdGeo = gltf.scene.children[ 0 ].geometry;
    const morphAttributes = birdGeo.morphAttributes.position;
    const tHeight = nextPowerOf2( durationAnimation ); //Calculate the dimensions of the texture using the nextPowerOf2 function to find the next power of two
    const tWidth = nextPowerOf2( birdGeo.getAttribute( 'position' ).count );
    indicesPerBird = birdGeo.index.count;

    //Creates a new float array to store the texture data, with four components per pixel (RGBA)
    const tData = new Float32Array( 4 * tWidth * tHeight );

    // Loop through positions to fill texture data
    for ( let i = 0; i < tWidth; i ++ ) {

        //Goes through each frame of the animation.
        for ( let j = 0; j < tHeight; j ++ ) {

            const offset = j * tWidth * 4;

            const curMorph = Math.floor( j / durationAnimation * morphAttributes.length );
            const nextMorph = ( Math.floor( j / durationAnimation * morphAttributes.length ) + 1 ) % morphAttributes.length;
            const lerpAmount = j / durationAnimation * morphAttributes.length % 1;

            //checks ensure that the interpolated values are only computed if the data is defined
            if ( j < durationAnimation ) {

                let d0, d1;

                d0 = morphAttributes[ curMorph ].array[ i * 3 ];
                d1 = morphAttributes[ nextMorph ].array[ i * 3 ];

                if ( d0 !== undefined && d1 !== undefined ) tData[ offset + i * 4 ] = Math.lerp( d0, d1, lerpAmount );

                d0 = morphAttributes[ curMorph ].array[ i * 3 + 1 ];
                d1 = morphAttributes[ nextMorph ].array[ i * 3 + 1 ];

                if ( d0 !== undefined && d1 !== undefined ) tData[ offset + i * 4 + 1 ] = Math.lerp( d0, d1, lerpAmount );

                d0 = morphAttributes[ curMorph ].array[ i * 3 + 2 ];
                d1 = morphAttributes[ nextMorph ].array[ i * 3 + 2 ];

                if ( d0 !== undefined && d1 !== undefined ) tData[ offset + i * 4 + 2 ] = Math.lerp( d0, d1, lerpAmount );

                tData[ offset + i * 4 + 3 ] = 1;

            }

        }

    }

    textureAnimation = new THREE.DataTexture( tData, tWidth, tHeight, THREE.RGBAFormat, THREE.FloatType );
    textureAnimation.needsUpdate = true;

    // Create geometry attributes from base model
    const vertices = [], color = [], reference = [], seeds = [], indices = [];
    const totalVertices = birdGeo.getAttribute( 'position' ).count * 3 * BIRDS;
    for ( let i = 0; i < totalVertices; i ++ ) {

        const bIndex = i % ( birdGeo.getAttribute( 'position' ).count * 3 );
        vertices.push( birdGeo.getAttribute( 'position' ).array[ bIndex ] );
        color.push( birdGeo.getAttribute( 'color' ).array[ bIndex ] );

    }

    let r = Math.random();
    for ( let i = 0; i < birdGeo.getAttribute( 'position' ).count * BIRDS; i ++ ) {

        const bIndex = i % ( birdGeo.getAttribute( 'position' ).count );
        const bird = Math.floor( i / birdGeo.getAttribute( 'position' ).count );
        if ( bIndex == 0 ) r = Math.random();
        const j = ~ ~ bird;
        const x = ( j % WIDTH ) / WIDTH;
        const y = ~ ~ ( j / WIDTH ) / WIDTH;
        reference.push( x, y, bIndex / tWidth, durationAnimation / tHeight );
        seeds.push( bird, r, Math.random(), Math.random() );

    }
    // fills the indices array with index data for each bird's geometry.
    for ( let i = 0; i < birdGeo.index.array.length * BIRDS; i ++ ) {
        // calculates the starting index for each bird
        const offset = Math.floor( i / birdGeo.index.array.length ) * ( birdGeo.getAttribute( 'position' ).count );
        indices.push( birdGeo.index.array[ i % birdGeo.index.array.length ] + offset );

    }

    BirdGeometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( vertices ), 3 ) );
    BirdGeometry.setAttribute( 'birdColor', new THREE.BufferAttribute( new Float32Array( color ), 3 ) );
    BirdGeometry.setAttribute( 'color', new THREE.BufferAttribute( new Float32Array( color ), 3 ) );
    BirdGeometry.setAttribute( 'reference', new THREE.BufferAttribute( new Float32Array( reference ), 4 ) );
    BirdGeometry.setAttribute( 'seeds', new THREE.BufferAttribute( new Float32Array( seeds ), 4 ) );

    BirdGeometry.setIndex( indices );

    init();
    animate();

} );

let container;
let camera, scene, renderer;
let mouseX = 0, mouseY = 0;

let windowHalfX = window.innerWidth / 2;
let windowHalfY = window.innerHeight / 2;

const BOUNDS = 800, BOUNDS_HALF = BOUNDS / 2;

let last = performance.now();

let gpuCompute;
let velocityVariable;
let positionVariable;
let positionUniforms;
let velocityUniforms;

const effectController = {

    separation: 28.0,
    alignment: 20.0,
    cohesion: 20.0,
    freedom: 0.75,
    size: sizes,
    count: Math.floor( BIRDS / 4 )

};

// Define the stress and calm values
const stressValues = {
    alignment: 0.67,
    cohesion: 40.55,
    count: 4096
};

const calmValues = {
    alignment: 82,
    cohesion: 36.42,
    count: 300
};

//Get stress data from endpoint
async function fetchOverallAverage() {
    try {
        const response = await fetch('http://localhost:5001/stress');
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const data = await response.json();
        return data.overall_average_stress;
        console.log(data.overall_average_stress)
    } catch (error) {
        console.error('There has been a problem with your fetch operation:', error);
        return null;
    }
}

// Function to find the next power of 2 for a given number
function nextPowerOf2( n ) {

    return Math.pow( 2, Math.ceil( Math.log( n ) / Math.log( 2 ) ) );
}

// Linear interpolation function added to Math object
Math.lerp = function ( value1, value2, amount ) {

    amount = Math.max( Math.min( amount, 1 ), 0 );
    return value1 + ( value2 - value1 ) * amount;
};
// Fetch the overall average when the page loads
window.onload = fetchOverallAverage;


function init() {

    container = document.createElement( 'div' );
    document.body.appendChild( container );

    camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 1, 3000 );
    camera.position.z = 350;

    scene = new THREE.Scene()
    scene.background = new THREE.Color( colors );
    scene.fog = new THREE.Fog( colors, 100, 1000 );

    // LIGHTS
    const hemiLight = new THREE.HemisphereLight( colors, 0xffffff, 4.5 );
    hemiLight.color.setHSL( 0.6, 1, 0.6, THREE.SRGBColorSpace );
    hemiLight.groundColor.setHSL( 0.095, 1, 0.75, THREE.SRGBColorSpace );
    hemiLight.position.set( 0, 50, 0 );
    scene.add( hemiLight );

    const dirLight = new THREE.DirectionalLight( 0x00CED1, 2.0 );
    dirLight.color.setHSL( 0.1, 1, 0.95, THREE.SRGBColorSpace );
    dirLight.position.set( - 1, 1.75, 1 );
    dirLight.position.multiplyScalar( 30 );
    scene.add( dirLight );

    renderer = new THREE.WebGLRenderer( { antialias: true } );
    renderer.setPixelRatio( window.devicePixelRatio );
    renderer.setSize( window.innerWidth, window.innerHeight );
    container.appendChild( renderer.domElement );

    initComputeRenderer();

    container.style.touchAction = 'none';
    container.addEventListener( 'pointermove', onPointerMove );

    window.addEventListener( 'resize', onWindowResize );

    initBirds( effectController );
}
//Initializing a GPU-based computation renderer
function initComputeRenderer() {

    gpuCompute = new GPUComputationRenderer( WIDTH, WIDTH, renderer );

    //textures that will store the positions and velocities of particles.
    const dtPosition = gpuCompute.createTexture();
    const dtVelocity = gpuCompute.createTexture();
    fillPositionTexture( dtPosition );
    fillVelocityTexture( dtVelocity );

    velocityVariable = gpuCompute.addVariable('textureVelocity', velocityFragmentShader, dtVelocity);
    positionVariable = gpuCompute.addVariable('texturePosition', positionFragmentShader, dtPosition);

    //Dependencies specify which textures a shader needs to read from to update its own texture.
    gpuCompute.setVariableDependencies( velocityVariable, [ positionVariable, velocityVariable ] );
    gpuCompute.setVariableDependencies( positionVariable, [ positionVariable, velocityVariable ] );

    //Uniforms are global GLSL variables that can be used by the shaders.
    //Various uniforms are initialized here to control different aspects of the simulation.
    positionUniforms = positionVariable.material.uniforms;
    velocityUniforms = velocityVariable.material.uniforms;

    positionUniforms[ 'time' ] = { value: 0.0 };
    positionUniforms[ 'delta' ] = { value: 0.0 };
    velocityUniforms[ 'time' ] = { value: 1.0 };
    velocityUniforms[ 'delta' ] = { value: 0.0 };
    velocityUniforms[ 'testing' ] = { value: 1.0 };
    velocityUniforms[ 'separationDistance' ] = { value: 1.0 };
    velocityUniforms[ 'alignmentDistance' ] = { value: 1.0 };
    velocityUniforms[ 'cohesionDistance' ] = { value: 1.0 };
    velocityUniforms[ 'freedomFactor' ] = { value: 1.0 };
    velocityUniforms[ 'predator' ] = { value: new THREE.Vector3() };
    velocityVariable.material.defines.BOUNDS = BOUNDS.toFixed( 2 );

    //Causes the texture to repeat
    velocityVariable.wrapS = THREE.RepeatWrapping;
    velocityVariable.wrapT = THREE.RepeatWrapping;
    positionVariable.wrapS = THREE.RepeatWrapping;
    positionVariable.wrapT = THREE.RepeatWrapping;

    //If there are any errors during initialization, they are logged to the console.
    const error = gpuCompute.init();

    if ( error !== null ) {

        console.error( error );

    }

}

function initBirds( effectController ) {

    const geometry = BirdGeometry;

    const m = new THREE.MeshStandardMaterial( {
        vertexColors: true,
        flatShading: true,
        roughness: 1,
        metalness: 0
    } );

    //A callback that allows customization of the shader before it's compiled
    m.onBeforeCompile = ( shader ) => {

        shader.uniforms.texturePosition = { value: null };
        shader.uniforms.textureVelocity = { value: null };
        shader.uniforms.textureAnimation = { value: textureAnimation };
        shader.uniforms.time = { value: 1.0 };
        shader.uniforms.size = { value: effectController.size };
        shader.uniforms.delta = { value: 0.0 };

        let token = '#define STANDARD';

        let insert = /* glsl */`
						attribute vec4 reference;
						attribute vec4 seeds;
						attribute vec3 birdColor;
						uniform sampler2D texturePosition;
						uniform sampler2D textureVelocity;
						uniform sampler2D textureAnimation;
						uniform float size;
						uniform float time;
					`;

        shader.vertexShader = shader.vertexShader.replace( token, token + insert );

        token = '#include <begin_vertex>';

        insert = /* glsl */`
						vec4 tmpPos = texture2D( texturePosition, reference.xy );

						vec3 pos = tmpPos.xyz;
						vec3 velocity = normalize(texture2D( textureVelocity, reference.xy ).xyz);
						vec3 aniPos = texture2D( textureAnimation, vec2( reference.z, mod( time + ( seeds.x ) * ( ( 0.0004 + seeds.y / 10000.0) + normalize( velocity ) / 20000.0 ), reference.w ) ) ).xyz;
						vec3 newPosition = position;

						newPosition = mat3( modelMatrix ) * ( newPosition + aniPos );
						newPosition *= size + seeds.y * size * 0.2;

						velocity.z *= -1.;
						float xz = length( velocity.xz );
						float xyz = 1.;
						float x = sqrt( 1. - velocity.y * velocity.y );

						float cosry = velocity.x / xz;
						float sinry = velocity.z / xz;

						float cosrz = x / xyz;
						float sinrz = velocity.y / xyz;

						mat3 maty =  mat3( cosry, 0, -sinry, 0    , 1, 0     , sinry, 0, cosry );
						mat3 matz =  mat3( cosrz , sinrz, 0, -sinrz, cosrz, 0, 0     , 0    , 1 );

						newPosition =  maty * matz * newPosition;
						newPosition += pos;

						vec3 transformed = vec3( newPosition );
					`;

        shader.vertexShader = shader.vertexShader.replace( token, insert );

        materialShader = shader;

    };

    birdMesh = new THREE.Mesh( geometry, m );
    birdMesh.rotation.y = Math.PI / 2;

    birdMesh.castShadow = true;
    birdMesh.receiveShadow = true;

    scene.add( birdMesh );

}
//initializes the texture with random positions for the birds.
function fillPositionTexture( texture ) {

    //the underlying data array of the texture
    const theArray = texture.image.data;

    for ( let k = 0, kl = theArray.length; k < kl; k += 4 ) {
        // setting random x, y, z positions for each bird within the specified bounds
        const x = Math.random() * BOUNDS - BOUNDS_HALF;
        const y = Math.random() * BOUNDS - BOUNDS_HALF;
        const z = Math.random() * BOUNDS - BOUNDS_HALF;

        theArray[ k + 0 ] = x;
        theArray[ k + 1 ] = y;
        theArray[ k + 2 ] = z;
        theArray[ k + 3 ] = 1;

    }

}

function fillVelocityTexture( texture ) {

    const theArray = texture.image.data;

    for ( let k = 0, kl = theArray.length; k < kl; k += 4 ) {

        const x = Math.random() - 0.5;
        const y = Math.random() - 0.5;
        const z = Math.random() - 0.5;

        theArray[ k + 0 ] = x * 10;
        theArray[ k + 1 ] = y * 10;
        theArray[ k + 2 ] = z * 10;
        theArray[ k + 3 ] = 1;

    }

}

function onWindowResize() {

    windowHalfX = window.innerWidth / 2;
    windowHalfY = window.innerHeight / 2;

    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    renderer.setSize( window.innerWidth, window.innerHeight );

}

function onPointerMove( event ) {

    if ( event.isPrimary === false ) return;

    mouseX = event.clientX - windowHalfX;
    mouseY = event.clientY - windowHalfY;

}

//

function animate() {

    requestAnimationFrame( animate );

    render();
}
//Continuously updates the position and behavior of birds in a 3D scene and then renders the scene
async function render() {

    const now = performance.now();
    let delta = ( now - last ) / 1000;

    if ( delta > 1 ) delta = 1; // safety cap on large deltas
    last = now;

    //update the time and delta values in the position and velocity shaders, helps the shaders know the current and passed time
    positionUniforms[ 'time' ].value = now;
    positionUniforms[ 'delta' ].value = delta;
    velocityUniforms[ 'time' ].value = now;
    velocityUniforms[ 'delta' ].value = delta;

    const overallAverage = await fetchOverallAverage();
    console.log("The overall average stress: " + overallAverage);

    //update the shader behavior uniforms
    if (overallAverage !== null) {
        effectController.alignment = THREE.MathUtils.mapLinear(overallAverage, 0, 100, calmValues.alignment, stressValues.alignment);
        effectController.cohesion = THREE.MathUtils.mapLinear(overallAverage, 0, 100, calmValues.cohesion, stressValues.cohesion);
        effectController.count = THREE.MathUtils.mapLinear(overallAverage, 0, 100, calmValues.count, stressValues.count);
    }

    velocityUniforms[ 'separationDistance' ].value = effectController.separation;
    velocityUniforms[ 'alignmentDistance' ].value = effectController.alignment;
    velocityUniforms[ 'cohesionDistance' ].value = effectController.cohesion;
    velocityUniforms[ 'freedomFactor' ].value = effectController.freedom;
    if ( materialShader ) materialShader.uniforms[ 'size' ].value = effectController.size;
    BirdGeometry.setDrawRange( 0, indicesPerBird * effectController.count );

    if ( materialShader ) materialShader.uniforms[ 'time' ].value = now / 1000;
    if ( materialShader ) materialShader.uniforms[ 'delta' ].value = delta;

    //updates the position of a "predator" based on the mouse position
    velocityUniforms[ 'predator' ].value.set( 0.5 * mouseX / windowHalfX, - 0.5 * mouseY / windowHalfY, 0 );

    //Resets the mouse coordinates to a large value, effectively moving the predator off-screen.
    mouseX = 10000;
    mouseY = 10000;

    //Tells the GPU to compute the new positions and velocities of the birds based on the updated values.
    gpuCompute.compute();

    //Update the textures used by the shaders to the newly computed positions and velocities.
    if ( materialShader ) materialShader.uniforms[ 'texturePosition' ].value = gpuCompute.getCurrentRenderTarget( positionVariable ).texture;
    if ( materialShader ) materialShader.uniforms[ 'textureVelocity' ].value = gpuCompute.getCurrentRenderTarget( velocityVariable ).texture;

    renderer.render( scene, camera );
}

