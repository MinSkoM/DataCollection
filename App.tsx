import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FACEMESH_LANDMARK_INDICES } from './constants';
import type { Scenario, UploadStatus, SensorData, FrameData, FaceMeshResult, Point } from './types';
import { LoadingSpinner, CheckCircleIcon, ExclamationTriangleIcon, RecordIcon, StopIcon } from './components/Icons';

// Helper function to check for iOS
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);

const App: React.FC = () => {
    // Check Library Loading State
    const [libsLoaded, setLibsLoaded] = useState(() => {
        const cv = (window as any).cv;
        const isCvReady = cv && cv.Mat;
        const isFaceMeshReady = 'FaceMesh' in window;
        return !!(isCvReady && isFaceMeshReady);
    });

    const [hasPermission, setHasPermission] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    
    // Ref for recording state to avoid stale closures in callbacks
    const isRecordingRef = useRef(false);

    const [scenario, setScenario] = useState<Scenario>('REAL_Normal');
    const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const faceMeshRef = useRef<any>(null);
    const animationFrameId = useRef<number | null>(null);

    const sensorDataBuffer = useRef<SensorData[]>([]);
    const recordedData = useRef<FrameData[]>([]);

    // Optical Flow Refs
    const prevGray = useRef<any>(null);
    const backgroundPoints = useRef<any>(null);

    // --- 1. Load Libraries Logic ---
    const loadLibraries = useCallback(() => {
        if (libsLoaded) return;
        const checkMediaPipe = 'FaceMesh' in window;
        const cv = (window as any).cv;
        const isOpenCvReady = cv && cv.Mat; 

        if (isOpenCvReady && checkMediaPipe) {
            setLibsLoaded(true);
        } else {
            if (!cv) { (window as any).cv = {}; }
            if (!(window as any).cv.onRuntimeInitialized) {
                (window as any).cv.onRuntimeInitialized = () => {
                    if ('FaceMesh' in window) setLibsLoaded(true);
                };
            }
        }
    }, [libsLoaded]);

    useEffect(() => {
        loadLibraries();
        const interval = setInterval(() => {
            const cv = (window as any).cv;
            if (cv && cv.Mat && 'FaceMesh' in window) {
                setLibsLoaded(true);
                clearInterval(interval);
            }
        }, 500);
        return () => clearInterval(interval);
    }, [loadLibraries]);

    // --- 2. Initialize FaceMesh ---
    const initializeFaceMesh = useCallback(() => {
        if (!libsLoaded || faceMeshRef.current) return;
        if (!('FaceMesh' in window)) return;

        const faceMesh = new (window as any).FaceMesh({
            locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
        });
        faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
        });
        faceMesh.onResults(onFaceMeshResults);
        faceMeshRef.current = faceMesh;
        console.log("FaceMesh Initialized");
    }, [libsLoaded]);

    // --- 3. Camera Handling ---
    const startCamera = useCallback(async () => {
        if (videoRef.current && videoRef.current.srcObject) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
            });
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }
            initializeFaceMesh();
        } catch (err) {
            setErrorMessage("Camera access is required.");
        }
    }, [initializeFaceMesh]);

    const handleConnect = async () => {
        if (!isIOS()) {
            setHasPermission(true);
            await startCamera();
            return;
        }
        try {
            const permissionState = await (DeviceMotionEvent as any).requestPermission();
            if (permissionState === 'granted') {
                setHasPermission(true);
                await startCamera();
            } else {
                setErrorMessage("Sensor permissions required.");
            }
        } catch (error) {
            setHasPermission(true);
            await startCamera();
        }
    };

    // --- 4. Sensor Logic ---
    const sensorListener = useCallback((event: DeviceMotionEvent) => {
        const { acceleration, rotationRate } = event;
        sensorDataBuffer.current.push({
            timestamp: Date.now(),
            accel: acceleration ? { x: acceleration.x || 0, y: acceleration.y || 0, z: acceleration.z || 0 } : null,
            gyro: rotationRate ? { alpha: rotationRate.alpha || 0, beta: rotationRate.beta || 0, gamma: rotationRate.gamma || 0 } : null,
        });
        if (sensorDataBuffer.current.length > 500) {
            sensorDataBuffer.current.splice(0, sensorDataBuffer.current.length - 500);
        }
    }, []);

    useEffect(() => {
        if (hasPermission) {
            window.addEventListener('devicemotion', sensorListener);
            return () => window.removeEventListener('devicemotion', sensorListener);
        }
    }, [hasPermission, sensorListener]);

    const interpolateSensorData = (timestamp: number) => {
        const buffer = sensorDataBuffer.current;
        if (buffer.length < 2) return { accel: null, gyro: null };

        let before: SensorData | null = null;
        let after: SensorData | null = null;
        
        for (let i = buffer.length - 1; i >= 0; i--) {
            if (buffer[i].timestamp <= timestamp) {
                before = buffer[i];
                if (i + 1 < buffer.length) after = buffer[i + 1];
                break;
            }
        }

        if (!before || !after) return { accel: before?.accel || null, gyro: before?.gyro || null };

        const t = (timestamp - before.timestamp) / (after.timestamp - before.timestamp);

        const lerp = (v1: any, v2: any) => {
            if (!v1 || !v2) return null;
            const res: any = {};
            Object.keys(v1).forEach(key => {
                res[key] = v1[key] + (v2[key] - v1[key]) * t;
            });
            return res;
        };

        return {
            accel: lerp(before.accel, after.accel),
            gyro: lerp(before.gyro, after.gyro),
        };
    };

    // --- 5. Main Loop (FaceMesh + OpenCV) ---
    const onFaceMeshResults = useCallback((results: any) => {
        const canvasCtx = canvasRef.current?.getContext('2d', { willReadFrequently: true });
        if (!canvasCtx || !videoRef.current || !canvasRef.current) return;

        const { videoWidth, videoHeight } = videoRef.current;
        if (canvasRef.current.width !== videoWidth || canvasRef.current.height !== videoHeight) {
            canvasRef.current.width = videoWidth;
            canvasRef.current.height = videoHeight;
        }
        
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, videoWidth, videoHeight);
        
        let faceLandmarks: FaceMeshResult | null = null;
        let faceBoundingBox = null;

        // Draw FaceMesh
        if (results.multiFaceLandmarks && results.multiFaceLandmarks[0]) {
            const landmarks = results.multiFaceLandmarks[0];
            faceLandmarks = {
                all: landmarks,
                specific: FACEMESH_LANDMARK_INDICES.map(i => landmarks[i]),
                flat: FACEMESH_LANDMARK_INDICES.flatMap(i => [landmarks[i].x, landmarks[i].y, landmarks[i].z])
            };

            canvasCtx.strokeStyle = 'rgba(75, 192, 192, 0.8)';
            canvasCtx.lineWidth = 2;
            faceLandmarks.specific.forEach(lm => {
                canvasCtx.beginPath();
                canvasCtx.arc(lm.x * videoWidth, lm.y * videoHeight, 2, 0, 2 * Math.PI);
                canvasCtx.stroke();
            });

            const xs = landmarks.map((l: Point) => l.x);
            const ys = landmarks.map((l: Point) => l.y);
            faceBoundingBox = {
                xMin: Math.min(...xs), xMax: Math.max(...xs),
                yMin: Math.min(...ys), yMax: Math.max(...ys),
            };
        }

        // --- OpenCV Processing & bg_variance Calculation ---
        const cv = (window as any).cv;
        
        // ประกาศตัวแปรเก็บ Variance ไว้ตรงนี้ เพื่อให้ scope ใช้งานได้จนจบฟังก์ชัน
        let currentBgVariance = 0; 

        if (cv && cv.Mat && videoWidth > 0) {
            let currentFrame: any = null;
            let currentGray: any = null;
            let mask: any = null;
            let tempPoints: any = null;
            let nextPoints: any = null;
            let status: any = null;
            let err: any = null;

            try {
                currentFrame = new cv.Mat(videoHeight, videoWidth, cv.CV_8UC4);
                canvasCtx.drawImage(videoRef.current, 0, 0, videoWidth, videoHeight);
                const frameImageData = canvasCtx.getImageData(0, 0, videoWidth, videoHeight);
                currentFrame.data.set(frameImageData.data);
                
                currentGray = new cv.Mat();
                cv.cvtColor(currentFrame, currentGray, cv.COLOR_RGBA2GRAY);

                if (prevGray.current) {
                    // 1. Initial Points Detection
                    if (!backgroundPoints.current || backgroundPoints.current.rows === 0) {
                        mask = new cv.Mat.zeros(videoHeight, videoWidth, cv.CV_8U);
                        if (faceBoundingBox) {
                            // Mask out the face
                            const x = faceBoundingBox.xMin * videoWidth - 20;
                            const y = faceBoundingBox.yMin * videoHeight - 20;
                            const w = (faceBoundingBox.xMax - faceBoundingBox.xMin) * videoWidth + 40;
                            const h = (faceBoundingBox.yMax - faceBoundingBox.yMin) * videoHeight + 40;
                            
                            if (x >= 0 && y >= 0 && x + w <= videoWidth && y + h <= videoHeight) {
                                cv.rectangle(mask, new cv.Point(x, y), new cv.Point(x + w, y + h), new cv.Scalar(255), -1);
                                cv.bitwise_not(mask, mask);
                            } else {
                                mask.setTo(new cv.Scalar(255));
                            }
                        } else {
                            mask.setTo(new cv.Scalar(255));
                        }
                        tempPoints = new cv.Mat();
                        cv.goodFeaturesToTrack(currentGray, tempPoints, 10, 0.1, 10, mask, 7, false, 0.04);
                        backgroundPoints.current = tempPoints; 
                    }

                    // 2. Optical Flow Calculation
                    if (backgroundPoints.current && backgroundPoints.current.rows > 0) {
                        nextPoints = new cv.Mat();
                        status = new cv.Mat();
                        err = new cv.Mat();
                        
                        cv.calcOpticalFlowPyrLK(prevGray.current, currentGray, backgroundPoints.current, nextPoints, status, err);
                        
                        const p0 = backgroundPoints.current.data32F; // Points in prev frame
                        const p1 = nextPoints.data32F;               // Points in current frame
                        const st = status.data;

                        let goodNewPoints = [];
                        let movements: number[] = []; // Array to store movement distances

                        for (let i = 0; i < st.length; i++) {
                            if (st[i] === 1) {
                                // Keep good points
                                goodNewPoints.push(p1[i * 2], p1[i * 2 + 1]);

                                // --- [FIX] Calculate Distance & Variance ---
                                const xOld = p0[i * 2];
                                const yOld = p0[i * 2 + 1];
                                const xNew = p1[i * 2];
                                const yNew = p1[i * 2 + 1];
                                
                                // Euclidean distance
                                const dist = Math.sqrt(Math.pow(xNew - xOld, 2) + Math.pow(yNew - yOld, 2));
                                movements.push(dist);
                                // -----------------------------------------
                            }
                        }

                        // --- [FIX] Calculate Variance from movements ---
                        if (movements.length > 0) {
                            const mean = movements.reduce((a, b) => a + b, 0) / movements.length;
                            const sqDiffs = movements.map(val => Math.pow(val - mean, 2));
                            const variance = sqDiffs.reduce((a, b) => a + b, 0) / movements.length;
                            currentBgVariance = variance; // Store in the variable we declared earlier
                        }
                        // ---------------------------------------------

                        if (backgroundPoints.current) backgroundPoints.current.delete();
                        backgroundPoints.current = goodNewPoints.length > 0 
                             ? cv.matFromArray(goodNewPoints.length / 2, 1, cv.CV_32FC2, goodNewPoints)
                             : null;
                    }
                }

                if (prevGray.current) prevGray.current.delete();
                prevGray.current = currentGray;
                currentGray = null;

            } catch (e) {
                console.warn("OpenCV Processing Error:", e);
                if (backgroundPoints.current) { backgroundPoints.current.delete(); backgroundPoints.current = null; }
                if (prevGray.current) { prevGray.current.delete(); prevGray.current = null; }
            } finally {
                if (currentFrame) currentFrame.delete();
                if (currentGray) currentGray.delete();
                if (mask) mask.delete();
                if (nextPoints) nextPoints.delete();
                if (status) status.delete();
                if (err) err.delete();
            }
        }

        // --- 6. Recording Logic ---
        if (isRecordingRef.current) { 
            const timestamp = Date.now();
            const { accel, gyro } = interpolateSensorData(timestamp);
            const opticalFlowPoints = backgroundPoints.current ? Array.from(backgroundPoints.current.data32F as number[]) : [];

            recordedData.current.push({
                timestamp,
                faceMesh: faceLandmarks ? faceLandmarks.flat : null,
                sensors: { accel, gyro },
                opticalFlow: opticalFlowPoints,
                bg_variance: currentBgVariance // --- [FIX] Added bg_variance to JSON ---
            });
            
            if (recordedData.current.length % 30 === 0) {
                console.log(`Recording... Frames: ${recordedData.current.length}, Variance: ${currentBgVariance.toFixed(4)}`);
            }
        }

        canvasCtx.restore();
    }, []); 

    const gameLoop = useCallback(async () => {
        if (!faceMeshRef.current || !videoRef.current || videoRef.current.readyState < 3) {
            animationFrameId.current = requestAnimationFrame(gameLoop);
            return;
        }
        await faceMeshRef.current.send({ image: videoRef.current });
        animationFrameId.current = requestAnimationFrame(gameLoop);
    }, []);

    useEffect(() => {
        if (hasPermission && libsLoaded) {
            startCamera().then(() => {
                animationFrameId.current = requestAnimationFrame(gameLoop);
            });
        }
        return () => {
            if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
        };
    }, [hasPermission, libsLoaded, startCamera, gameLoop]);

    const toggleRecording = () => {
        if (isRecording) {
            // STOP
            setIsRecording(false);
            isRecordingRef.current = false;
            
            console.log("Stopping... Data count:", recordedData.current.length);
            
            if (recordedData.current.length > 0) {
                uploadData({ scenario, data: recordedData.current });
            } else {
                console.warn("No data collected!");
                setErrorMessage("No data was collected. Try again.");
                setTimeout(() => setErrorMessage(null), 3000);
            }
        } else {
            // START
            recordedData.current = [];
            setIsRecording(true);
            isRecordingRef.current = true;
            setUploadStatus('idle');
            console.log("Started Recording");
        }
    };

    const uploadData = async (payload: any) => {
        setUploadStatus('uploading');
        try {
            // Use localhost:5000 as configured
            const res = await fetch('http://localhost:5000/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error("Upload failed");
            setUploadStatus('success');
            console.log("Upload Success!");
            setTimeout(() => setUploadStatus('idle'), 3000);
        } catch (err: any) {
            setUploadStatus('error');
            setErrorMessage(err.message);
            console.error("Upload Error:", err);
        }
    };

    if (!libsLoaded) {
        return (
            <div className="w-screen h-screen flex flex-col items-center justify-center bg-gray-900 text-white">
                <LoadingSpinner />
                <p className="mt-4 text-lg">Initializing OpenCV & MediaPipe...</p>
            </div>
        );
    }

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-black">
            <video ref={videoRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-contain transform -scale-x-100" />
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain transform -scale-x-100" />
            
            {!hasPermission && (
                <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
                    <button onClick={handleConnect} className="bg-blue-600 px-8 py-4 rounded-xl font-bold text-white shadow-2xl">
                        Enable Sensors & Camera
                    </button>
                </div>
            )}

            {hasPermission && (
                <div className="absolute bottom-0 w-full p-6 bg-black/60 backdrop-blur-md flex items-center gap-4">
                    <select 
                        value={scenario} 
                        onChange={(e) => setScenario(e.target.value as Scenario)}
                        disabled={isRecording}
                        className="bg-gray-800 text-white p-3 rounded-lg flex-1"
                    >
                        <option value="REAL_Normal">REAL_Normal</option>
                        <option value="REAL_WhiteWall">REAL_WhiteWall</option>
                        <option value="REAL_Backlight">REAL_Backlight</option>
                        <option value="REAL_Walking">REAL_Walking</option>
                        <option value="Spoof_2DWall">Spoof_2DWall</option>
                        <option value="Spoof_2DScreen">Spoof_2DScreen</option>
                        <option value="Spoof_2DVideoReplay">Spoof_2DVideoReplay</option>
                        <option value="Spoof_RandomMotion">Spoof_RandomMotion</option>
                    </select>

                    <button onClick={toggleRecording} className={`p-5 rounded-full ${isRecording ? 'bg-red-500' : 'bg-green-500'}`}>
                        {isRecording ? <StopIcon /> : <RecordIcon />}
                    </button>

                    <div className="flex-1 flex justify-end">
                        <Toast status={uploadStatus} message={errorMessage} />
                    </div>
                </div>
            )}
        </div>
    );
};

const Toast: React.FC<{ status: UploadStatus; message: string | null }> = ({ status, message }) => {
    if (status === 'idle') return null;
    const config = {
        uploading: { icon: <LoadingSpinner />, text: "Uploading...", color: "bg-blue-600" },
        success: { icon: <CheckCircleIcon />, text: "Done!", color: "bg-green-600" },
        error: { icon: <ExclamationTriangleIcon />, text: message || "Error", color: "bg-red-600" }
    };
    const { icon, text, color } = config[status];
    return (
        <div className={`flex items-center gap-2 px-4 py-2 rounded-lg text-white ${color}`}>
            {icon} <span>{text}</span>
        </div>
    );
};

export default App;