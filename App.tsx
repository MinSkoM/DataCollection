import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FACEMESH_LANDMARK_INDICES } from './constants';
import type { Scenario, UploadStatus, SensorData, FrameData, FaceMeshResult, Point } from './types';
import { LoadingSpinner, CheckCircleIcon, ExclamationTriangleIcon } from './components/Icons';

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
    const [isReviewing, setIsReviewing] = useState(false);
    
    // Ref for recording state
    const isRecordingRef = useRef(false);

    // Dropdown States
    const [scenario, setScenario] = useState<Scenario>('Normal');
    const [type, setType] = useState<string>('REAL');
    const [motion, setMotion] = useState<string>('orbital_RL');
    
    const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    
    // --- [NEW] Camera State & Ref ---
    // เก็บสถานะว่าใช้กล้องหน้าหรือหลัง
    const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
    // ใช้ Ref เพื่อให้ Logic ใน Loop เห็นค่าล่าสุดเสมอโดยไม่ต้อง Re-render Loop
    const facingModeRef = useRef<'user' | 'environment'>('user'); 

    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const faceMeshRef = useRef<any>(null);
    const animationFrameId = useRef<number | null>(null);

    const sensorDataBuffer = useRef<SensorData[]>([]);
    const recordedData = useRef<FrameData[]>([]);

    // Optical Flow Refs
    const prevGray = useRef<any>(null);
    const backgroundPoints = useRef<any>(null);
    const prevNoseRef = useRef<{x: number, y: number} | null>(null);

    // --- Load Libraries ---
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

    // --- Initialize FaceMesh ---
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

    // --- [MODIFIED] Camera Setup (รับ Mode ได้) ---
    const setupCamera = async (mode: 'user' | 'environment' = 'user') => {
        try {
            // Stop old tracks
            if (videoRef.current && videoRef.current.srcObject) {
                const stream = videoRef.current.srcObject as MediaStream;
                stream.getTracks().forEach(track => track.stop());
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    facingMode: mode, 
                    width: { ideal: 640 }, 
                    height: { ideal: 480 },
                    frameRate: { ideal: 30 }
                },
                audio: false
            });

            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.onloadedmetadata = () => {
                    videoRef.current?.play();
                    
                    // Reset Logic ของ Optical Flow เมื่อสลับกล้อง
                    if(backgroundPoints.current) { backgroundPoints.current.delete(); backgroundPoints.current = null; }
                    if(prevGray.current) { prevGray.current.delete(); prevGray.current = null; }
                    prevNoseRef.current = null;
                };
            }
            
            if (!faceMeshRef.current) initializeFaceMesh();

        } catch (err) {
            console.error(err);
            setErrorMessage("Camera access denied or error.");
        }
    };

    // --- [NEW] Toggle Camera Logic ---
    const toggleCamera = useCallback(() => {
        if (isRecordingRef.current) return; // ห้ามสลับตอนอัด
        const newMode = facingMode === 'user' ? 'environment' : 'user';
        
        setFacingMode(newMode);
        facingModeRef.current = newMode; // อัปเดต Ref ทันทีสำหรับ Loop
        
        setupCamera(newMode);
    }, [facingMode]);

    const handleConnect = async () => {
        if (!isIOS()) {
            setHasPermission(true);
            await setupCamera('user');
            return;
        }
        try {
            const permissionState = await (DeviceMotionEvent as any).requestPermission();
            if (permissionState === 'granted') {
                setHasPermission(true);
                await setupCamera('user');
            } else {
                setErrorMessage("Sensor permissions required.");
            }
        } catch (error) {
            setHasPermission(true);
            await setupCamera('user');
        }
    };

    // --- Sensor Logic ---
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

    // --- Main Loop ---
    const onFaceMeshResults = useCallback((results: any) => {
        const canvasCtx = canvasRef.current?.getContext('2d', { willReadFrequently: true });
        if (!canvasCtx || !videoRef.current || !canvasRef.current) return;

        const { videoWidth, videoHeight } = videoRef.current;
        if (canvasRef.current.width !== videoWidth || canvasRef.current.height !== videoHeight) {
            canvasRef.current.width = videoWidth;
            canvasRef.current.height = videoHeight;
        }
        
        canvasCtx.clearRect(0, 0, videoWidth, videoHeight);
        
        let faceLandmarks: FaceMeshResult | null = null;
        let faceBoundingBox = null;
        let noseX = 0, noseY = 0;
        let faceDx = 0, faceDy = 0;

        // --- DRAWING & FACE TRACKING ---
        if (results.multiFaceLandmarks && results.multiFaceLandmarks[0]) {
            const landmarks = results.multiFaceLandmarks[0];
            
            faceLandmarks = {
                all: landmarks,
                specific: FACEMESH_LANDMARK_INDICES.map(i => landmarks[i]),
                flat: FACEMESH_LANDMARK_INDICES.flatMap(i => [landmarks[i].x, landmarks[i].y, landmarks[i].z])
            };

            const nose = landmarks[1];
            noseX = nose.x * videoWidth;
            noseY = nose.y * videoHeight;

            if (prevNoseRef.current) {
                faceDx = noseX - prevNoseRef.current.x;
                faceDy = noseY - prevNoseRef.current.y;
            }
            prevNoseRef.current = { x: noseX, y: noseY };

            // Draw Face
            canvasCtx.fillStyle = 'rgba(0, 255, 255, 0.4)';
            landmarks.forEach((lm: Point) => {
                const x = lm.x * videoWidth;
                const y = lm.y * videoHeight;
                canvasCtx.beginPath();
                canvasCtx.arc(x, y, 1, 0, 2 * Math.PI);
                canvasCtx.fill();
            });
            
            // Bounding Box
            const xs = landmarks.map((l: Point) => l.x);
            const ys = landmarks.map((l: Point) => l.y);
            faceBoundingBox = {
                xMin: Math.min(...xs), xMax: Math.max(...xs),
                yMin: Math.min(...ys), yMax: Math.max(...ys),
            };
        }

        // --- OpenCV Processing ---
        const cv = (window as any).cv;
        let currentBgVariance = 0;
        let flowStats = { count: 0, avgX: 0, avgY: 0, avgMag: 0 };

        if (cv && cv.Mat && videoWidth > 0) {
            let currentFrame: any = null;
            let currentGray: any = null;
            let mask: any = null;
            let nextPoints: any = null;
            let status: any = null;
            let err: any = null;

            try {
                currentFrame = new cv.Mat(videoHeight, videoWidth, cv.CV_8UC4);
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = videoWidth;
                tempCanvas.height = videoHeight;
                const tempCtx = tempCanvas.getContext('2d');
                if (tempCtx) {
                    tempCtx.drawImage(videoRef.current, 0, 0, videoWidth, videoHeight);
                    const frameImageData = tempCtx.getImageData(0, 0, videoWidth, videoHeight);
                    currentFrame.data.set(frameImageData.data);
                }

                currentGray = new cv.Mat();
                cv.cvtColor(currentFrame, currentGray, cv.COLOR_RGBA2GRAY);

                if (prevGray.current) {
                    if (!backgroundPoints.current || backgroundPoints.current.rows < 30) {
                        if (backgroundPoints.current) { backgroundPoints.current.delete(); backgroundPoints.current = null; }
                        mask = new cv.Mat(videoHeight, videoWidth, cv.CV_8U, new cv.Scalar(255));
                        
                        if (faceBoundingBox) {
                            let x = Math.floor(faceBoundingBox.xMin * videoWidth - 20);
                            let y = Math.floor(faceBoundingBox.yMin * videoHeight - 20);
                            let w = Math.floor((faceBoundingBox.xMax - faceBoundingBox.xMin) * videoWidth + 40);
                            let h = Math.floor((faceBoundingBox.yMax - faceBoundingBox.yMin) * videoHeight + 40);
                            
                            let x1 = Math.max(0, x);
                            let y1 = Math.max(0, y);
                            let x2 = Math.min(videoWidth, x + w);
                            let y2 = Math.min(videoHeight, y + h);

                            if (x2 > x1 && y2 > y1) {
                                cv.rectangle(mask, new cv.Point(x1, y1), new cv.Point(x2, y2), new cv.Scalar(0), -1);
                            }
                        }

                        const newDetectedPoints = new cv.Mat();
                        cv.goodFeaturesToTrack(currentGray, newDetectedPoints, 100, 0.01, 15, mask, 3, false, 0.04);
                        backgroundPoints.current = newDetectedPoints; 
                    }

                    if (backgroundPoints.current && backgroundPoints.current.rows > 0) {
                        nextPoints = new cv.Mat();
                        status = new cv.Mat();
                        err = new cv.Mat();
                        cv.calcOpticalFlowPyrLK(prevGray.current, currentGray, backgroundPoints.current, nextPoints, status, err);
                        
                        const p0 = backgroundPoints.current.data32F;
                        const p1 = nextPoints.data32F;
                        const st = status.data;
                        let goodNewPoints = [];
                        let movements: number[] = [];
                        let sumDx = 0, sumDy = 0, sumMag = 0;
                        let validCount = 0;

                        for (let i = 0; i < st.length; i++) {
                            if (st[i] === 1) {
                                goodNewPoints.push(p1[i * 2], p1[i * 2 + 1]);
                                const dx = p1[i * 2] - p0[i * 2];
                                const dy = p1[i * 2 + 1] - p0[i * 2 + 1];
                                const dist = Math.sqrt(dx*dx + dy*dy);
                                movements.push(dist);
                                sumDx += dx;
                                sumDy += dy;
                                sumMag += dist;
                                validCount++;
                            }
                        }

                        if (movements.length > 0) {
                            const mean = movements.reduce((a, b) => a + b, 0) / movements.length;
                            const sqDiffs = movements.map(val => Math.pow(val - mean, 2));
                            currentBgVariance = sqDiffs.reduce((a, b) => a + b, 0) / movements.length;
                        }

                        if (validCount > 0) {
                            flowStats = { count: validCount, avgX: sumDx / validCount, avgY: sumDy / validCount, avgMag: sumMag / validCount };
                        }

                        if (backgroundPoints.current) backgroundPoints.current.delete();
                        if (goodNewPoints.length > 0) {
                            backgroundPoints.current = cv.matFromArray(goodNewPoints.length / 2, 1, cv.CV_32FC2, goodNewPoints);
                        } else {
                            backgroundPoints.current = null;
                        }
                    }
                }
                if (prevGray.current) prevGray.current.delete();
                prevGray.current = currentGray;
                currentGray = null;

            } catch (e) {
                console.warn("OpenCV Error:", e);
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

        // --- 4. Recording Logic ---
        if (isRecordingRef.current) { 
            const timestamp = Date.now();
            const { accel, gyro } = interpolateSensorData(timestamp);
            
            // --- [MODIFIED] Sensor Inversion Logic ---
            // ถ้าเป็นกล้องหลัง ('environment') ให้กลับค่า accel.x เพื่อให้ทิศทางสอดคล้องกับกล้องหน้า
            const currentMode = facingModeRef.current;
            const sensorMultiplier = currentMode === 'environment' ? -1 : 1;

            const adjustedAccel = accel ? {
                x: accel.x * sensorMultiplier,
                y: accel.y,
                z: accel.z
            } : null;
            
            // หมายเหตุ: Gyro อาจต้องปรับตามแกนการหมุน แต่ Accel X คือสิ่งที่ส่งผลกับการแยกแยะซ้ายขวามากที่สุดในการเทรน
            const adjustedGyro = gyro ? {
                x: gyro.beta || 0,   // แก้จาก gyro.x เป็น gyro.beta
                y: gyro.gamma || 0,  // แก้จาก gyro.y เป็น gyro.gamma
                z: gyro.alpha || 0   // แก้จาก gyro.z เป็น gyro.alpha
            } : null;

            // Capture Image
            let imageBase64 = null;
            if (videoRef.current && videoRef.current.videoWidth > 0) {
                try {
                    const videoEl = videoRef.current;
                    const tempCanvas = document.createElement('canvas');
                    const scale = 480 / videoEl.videoWidth;
                    tempCanvas.width = 480;
                    tempCanvas.height = videoEl.videoHeight * scale;
                    const tempCtx = tempCanvas.getContext('2d');
                    if (tempCtx) {
                        tempCtx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
                        imageBase64 = tempCanvas.toDataURL('image/jpeg', 0.7);
                    }
                } catch (err) { console.error("Capture Error:", err); }
            }

            const relativeX = faceDx - flowStats.avgX;
            const relativeY = faceDy - flowStats.avgY;
            const relativeMag = Math.sqrt(relativeX * relativeX + relativeY * relativeY);

            recordedData.current.push({
                timestamp,
                faceMesh: faceLandmarks ? faceLandmarks.flat : null,
                sensors: { accel: adjustedAccel, gyro: adjustedGyro }, // บันทึกค่าที่กลับด้านแล้ว
                opticalFlowStats: { ...flowStats, variance: currentBgVariance },
                motion_analysis: {
                    face_dx: faceDx,
                    face_dy: faceDy,
                    bg_dx: flowStats.avgX,
                    bg_dy: flowStats.avgY,
                    relative_magnitude: relativeMag
                },
                bg_variance: currentBgVariance,
                image: imageBase64,
                meta: { camera_facing: currentMode } 
            });
            
            if (recordedData.current.length % 30 === 0) {
                const hasImg = imageBase64 ? "📸" : "❌";
                console.log(`Rec: ${recordedData.current.length} | Cam: ${currentMode} | ${hasImg}`);
            }
        }
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
            setupCamera('user').then(() => {
                animationFrameId.current = requestAnimationFrame(gameLoop);
            });
        }
        return () => {
            if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
        };
    }, [hasPermission, libsLoaded]);

    const toggleRecording = () => {
        if (isRecording) {
            setIsRecording(false);
            isRecordingRef.current = false;
            if (recordedData.current.length > 0) {
                setIsReviewing(true);
            } else {
                setErrorMessage("No data collected.");
                setTimeout(() => setErrorMessage(null), 3000);
            }
        } else {
            recordedData.current = [];
            setIsRecording(true);
            isRecordingRef.current = true;
            setUploadStatus('idle');
        }
    };

    const uploadData = async (payload: any) => {
        setUploadStatus('uploading');
        try {
            const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'; 
            const res = await fetch(`${apiUrl}/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error("Upload failed");
            setUploadStatus('success');
            setTimeout(() => setUploadStatus('idle'), 3000);
        } catch (err: any) {
            setUploadStatus('error');
            setErrorMessage(err.message);
        }
    };

    const handleConfirmUpload = () => {
        setIsReviewing(false);
        uploadData({ type, scenario, motion, data: recordedData.current });
    };

    const handleDiscard = () => {
        setIsReviewing(false);
        recordedData.current = [];
    };

    if (!libsLoaded) {
        return (
            <div className="w-screen h-screen flex flex-col items-center justify-center bg-gray-900 text-white">
                <LoadingSpinner />
                <p className="mt-4 text-lg">Initializing...</p>
            </div>
        );
    }

    return (
        // เปลี่ยน Main Container เป็น Flex Column เพื่อแบ่งบน-ล่าง
        <div className="flex flex-col h-[100dvh] bg-black overflow-hidden">
            
            {/* --- ส่วนที่ 1: พื้นที่แสดงผลกล้อง (ยืดเต็มพื้นที่ที่เหลือ) --- */}
            <div className="relative flex-1 min-h-0 w-full bg-black overflow-hidden group">
                <video 
                    ref={videoRef} 
                    autoPlay playsInline muted 
                    className="absolute inset-0 w-full h-full object-cover"
                    style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }} 
                />
                <canvas 
                    ref={canvasRef} 
                    className="absolute inset-0 w-full h-full object-cover"
                    style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }}
                />

                {/* ปุ่มสลับกล้อง (ย้ายมาอยู่ในกรอบวิดีโอ) */}
                {hasPermission && !isRecording && !isReviewing && (
                    <button 
                        onClick={toggleCamera}
                        className="absolute top-4 right-4 p-3 bg-gray-800/60 hover:bg-gray-700/80 rounded-full backdrop-blur-sm z-30 text-white border border-white/10 shadow-lg transition-all"
                        title="Switch Camera"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                        </svg>
                    </button>
                )}

                {/* หน้าขออนุญาตกล้อง */}
                {!hasPermission && (
                    <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
                        <button onClick={handleConnect} className="bg-blue-600 px-8 py-4 rounded-xl font-bold text-white shadow-2xl hover:bg-blue-500 transition-colors">
                            Start Camera & Sensors
                        </button>
                    </div>
                )}

                {/* Review Mode Overlay (ยังคงทับวิดีโอได้เพราะเป็นการเช็คภาพ) */}
                {isReviewing && (
                    <div className="absolute inset-0 bg-black/90 z-50 flex flex-col items-center justify-center space-y-6 p-4 text-center">
                        <div className="text-white text-2xl font-bold">Recording Finished</div>
                        <div className="text-gray-300">
                            Captured Frames: <span className="text-yellow-400 font-mono text-xl">{recordedData.current.length}</span>
                        </div>
                        
                        <div className="flex gap-4 mt-4 w-full justify-center">
                            <button 
                                onClick={handleDiscard}
                                className="px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-xl font-bold"
                            >
                                ❌ Discard
                            </button>
                            <button 
                                onClick={handleConfirmUpload}
                                className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold shadow-lg border-2 border-green-400"
                            >
                                ✅ Save
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* --- ส่วนที่ 2: แผงควบคุม (Console) แยกออกมาด้านล่าง ไม่บังจอ --- */}
            {hasPermission && !isReviewing && (
                <div className="shrink-0 z-40 w-full bg-gray-900 border-t border-white/10 pb-safe">
                    <div className="p-4 flex flex-col gap-3 max-w-lg mx-auto w-full">
                        
                        {/* Dropdowns Row 1 */}
                        <select
                            value={type}
                            onChange={(e) => setType(e.target.value)}
                            disabled={isRecording}
                            className="bg-gray-800 text-white text-sm p-3 rounded-xl border border-gray-700 focus:outline-none focus:border-green-500 w-full"
                        >
                            <option value="REAL">Real</option>
                            <option value="Spoof_2DScreen">Spoof - Photo Screen</option>
                            <option value="Spoof_VideoReplay">Spoof - Video Replay</option>
                            <option value="Spoof_TimeShift">Spoof - Time Shift</option>
                        </select>

                        {/* Dropdowns Row 2 */}
                        <div className="grid grid-cols-2 gap-3">
                            <select
                                value={scenario}
                                onChange={(e) => setScenario(e.target.value as Scenario)}
                                disabled={isRecording}
                                className="bg-gray-800 text-white text-sm p-3 rounded-xl border border-gray-700 focus:outline-none focus:border-green-500"
                            >
                                <option value="Normal">Normal</option>
                                <option value="WhiteWall">White Wall</option>
                                <option value="Walking">Walking</option>
                            </select>

                            <select
                                value={motion}
                                onChange={(e) => setMotion(e.target.value)}
                                disabled={isRecording}
                                className="bg-gray-800 text-white text-sm p-3 rounded-xl border border-gray-700 focus:outline-none focus:border-green-500"
                            >
                                <option value="orbital_RL">Orbital R-L</option>
                                <option value="orbital_LR">Orbital L-R</option>
                                <option value="push-pull">Push-Pull</option>
                                <option value="pull-push">Pull-Push</option>
                                <option value="THT_R">THT R</option>
                                <option value="THT_L">THT L</option>
                            </select>
                        </div>

                        {/* Record Button & Status Row */}
                        <div className="flex items-center justify-between mt-2 px-2">
                            <div className="flex-1 flex justify-start">
                                <Toast status={uploadStatus} message={errorMessage} />
                            </div>
                            
                            <button
                                onClick={toggleRecording}
                                className={`relative flex items-center justify-center w-16 h-16 rounded-full border-4 border-white/20 transition-all duration-200 active:scale-95 shadow-lg mx-4 ${
                                    isRecording ? 'bg-red-900/50 border-red-500' : 'bg-white/5 hover:bg-white/10'
                                }`}
                            >
                                <div
                                    className={`transition-all duration-300 ${
                                    isRecording 
                                        ? 'w-6 h-6 bg-red-500 rounded-sm' 
                                        : 'w-12 h-12 bg-red-600 rounded-full border-2 border-white' 
                                    }`}
                                />
                            </button>
                            
                            <div className="flex-1"></div>
                        </div>
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