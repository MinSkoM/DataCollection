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
    
    const [isReviewing, setIsReviewing] = useState(false);
    // Ref for recording state to avoid stale closures
    const isRecordingRef = useRef(false);

    // แก้ไขค่าเริ่มต้นให้ตรงกับ Dropdown
    const [scenario, setScenario] = useState<Scenario>('Normal');
    const [type, setType] = useState<string>('REAL');
    const [motion, setMotion] = useState<string>('orbital_RL');
    
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
    const prevNoseRef = useRef<{x: number, y: number} | null>(null);

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

    // --- 5. Main Loop (FaceMesh + OpenCV + DRAWING) ---
    const onFaceMeshResults = useCallback((results: any) => {
        const canvasCtx = canvasRef.current?.getContext('2d', { willReadFrequently: true });
        if (!canvasCtx || !videoRef.current || !canvasRef.current) return;

        const { videoWidth, videoHeight } = videoRef.current;
        if (canvasRef.current.width !== videoWidth || canvasRef.current.height !== videoHeight) {
            canvasRef.current.width = videoWidth;
            canvasRef.current.height = videoHeight;
        }
        
        // --- 1. CLEAR CANVAS ---
        canvasCtx.clearRect(0, 0, videoWidth, videoHeight);
        
        let faceLandmarks: FaceMeshResult | null = null;
        let faceBoundingBox = null;
        
        // ตัวแปรสำหรับ Relative Motion
        let noseX = 0, noseY = 0;
        let faceDx = 0, faceDy = 0;

        // --- 2. DRAWING LOGIC & FACE TRACKING ---
        if (results.multiFaceLandmarks && results.multiFaceLandmarks[0]) {
            const landmarks = results.multiFaceLandmarks[0];
            
            // A. เตรียมข้อมูล FaceMesh
            faceLandmarks = {
                all: landmarks,
                specific: FACEMESH_LANDMARK_INDICES.map(i => landmarks[i]),
                flat: FACEMESH_LANDMARK_INDICES.flatMap(i => [landmarks[i].x, landmarks[i].y, landmarks[i].z])
            };

            // B. คำนวณ Face Motion (จากจมูก Index 1)
            const nose = landmarks[1];
            noseX = nose.x * videoWidth;
            noseY = nose.y * videoHeight;

            if (prevNoseRef.current) {
                faceDx = noseX - prevNoseRef.current.x;
                faceDy = noseY - prevNoseRef.current.y;
            }
            // อัปเดตตำแหน่งจมูกล่าสุด
            prevNoseRef.current = { x: noseX, y: noseY };

            // C. วาดโครงสร้างหน้า
            canvasCtx.fillStyle = 'rgba(0, 255, 255, 0.4)';
            landmarks.forEach((lm: Point) => {
                const x = lm.x * videoWidth;
                const y = lm.y * videoHeight;
                canvasCtx.beginPath();
                canvasCtx.arc(x, y, 1, 0, 2 * Math.PI);
                canvasCtx.fill();
            });

            // D. วาดจุดสำคัญ
            canvasCtx.fillStyle = '#00FF00';
            faceLandmarks.specific.forEach((lm: Point) => {
                const x = lm.x * videoWidth;
                const y = lm.y * videoHeight;
                canvasCtx.beginPath();
                canvasCtx.arc(x, y, 2, 0, 2 * Math.PI);
                canvasCtx.fill();
                canvasCtx.stroke();
            });

            // E. คำนวณ Bounding Box (สำหรับ Mask OpenCV)
            const xs = landmarks.map((l: Point) => l.x);
            const ys = landmarks.map((l: Point) => l.y);
            faceBoundingBox = {
                xMin: Math.min(...xs), xMax: Math.max(...xs),
                yMin: Math.min(...ys), yMax: Math.max(...ys),
            };
        }

        // --- 3. OpenCV Processing & Optical Flow ---
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
                // เตรียมภาพ Grayscale
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
                    // ---------------------------------------------------------
                    // 3.1 Initial Points Detection (แก้ Bug จุดค้าง + Mask หลุด)
                    // ---------------------------------------------------------
                    if (!backgroundPoints.current || backgroundPoints.current.rows < 30) {
                        
                        if (backgroundPoints.current) {
                            backgroundPoints.current.delete();
                            backgroundPoints.current = null;
                        }

                        // สร้าง Mask สีขาว (พื้นที่ยอมให้จับจุด)
                        mask = new cv.Mat(videoHeight, videoWidth, cv.CV_8U, new cv.Scalar(255));
                        
                        if (faceBoundingBox) {
                            // คำนวณกรอบหน้า + ขยายขอบ 20px (Clamping ไม่ให้หลุดจอ)
                            let x = Math.floor(faceBoundingBox.xMin * videoWidth - 20);
                            let y = Math.floor(faceBoundingBox.yMin * videoHeight - 20);
                            let w = Math.floor((faceBoundingBox.xMax - faceBoundingBox.xMin) * videoWidth + 40);
                            let h = Math.floor((faceBoundingBox.yMax - faceBoundingBox.yMin) * videoHeight + 40);
                            
                            let x1 = Math.max(0, x);
                            let y1 = Math.max(0, y);
                            let x2 = Math.min(videoWidth, x + w);
                            let y2 = Math.min(videoHeight, y + h);

                            // ระบายสีดำทับหน้า (ห้ามจับจุดบนหน้า)
                            if (x2 > x1 && y2 > y1) {
                                cv.rectangle(mask, new cv.Point(x1, y1), new cv.Point(x2, y2), new cv.Scalar(0), -1);
                            }
                        }

                        // หาจุดบน BG
                        const newDetectedPoints = new cv.Mat();
                        // minDistance = 15 เพื่อให้จุดกระจายตัว
                        cv.goodFeaturesToTrack(currentGray, newDetectedPoints, 100, 0.01, 15, mask, 3, false, 0.04);
                        
                        // Assign ให้ Ref ถือครอง (ห้าม delete newDetectedPoints ใน finally)
                        backgroundPoints.current = newDetectedPoints; 
                    }

                    // ---------------------------------------------------------
                    // 3.2 Optical Flow Calculation
                    // ---------------------------------------------------------
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

                        // คำนวณ Variance
                        if (movements.length > 0) {
                            const mean = movements.reduce((a, b) => a + b, 0) / movements.length;
                            const sqDiffs = movements.map(val => Math.pow(val - mean, 2));
                            currentBgVariance = sqDiffs.reduce((a, b) => a + b, 0) / movements.length;
                        }

                        // อัปเดต Flow Stats
                        if (validCount > 0) {
                            flowStats = {
                                count: validCount,
                                avgX: sumDx / validCount,
                                avgY: sumDy / validCount,
                                avgMag: sumMag / validCount
                            };
                        }

                        // อัปเดตจุดสำหรับรอบถัดไป
                        if (backgroundPoints.current) backgroundPoints.current.delete();
                        if (goodNewPoints.length > 0) {
                            backgroundPoints.current = cv.matFromArray(goodNewPoints.length / 2, 1, cv.CV_32FC2, goodNewPoints);
                        } else {
                            backgroundPoints.current = null;
                        }
                    }
                }

                // Update prevGray
                if (prevGray.current) prevGray.current.delete();
                prevGray.current = currentGray;
                currentGray = null;

            } catch (e) {
                console.warn("OpenCV Error:", e);
                if (backgroundPoints.current) { backgroundPoints.current.delete(); backgroundPoints.current = null; }
                if (prevGray.current) { prevGray.current.delete(); prevGray.current = null; }
            } finally {
                // Cleanup Memory
                if (currentFrame) currentFrame.delete();
                if (currentGray) currentGray.delete();
                if (mask) mask.delete();
                if (nextPoints) nextPoints.delete();
                if (status) status.delete();
                if (err) err.delete();
                // *ไม่ต้องลบ tempPoints/newDetectedPoints เพราะส่งให้ ref ไปแล้ว*
            }
        }

        // --- 4. Recording Logic ---
        if (isRecordingRef.current) { 
            const timestamp = Date.now();
            const { accel, gyro } = interpolateSensorData(timestamp);
            
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
                } catch (err) {
                    console.error("Capture Error:", err);
                }
            }

            // คำนวณ Relative Motion (Face vs BG)
            const relativeX = faceDx - flowStats.avgX;
            const relativeY = faceDy - flowStats.avgY;
            const relativeMag = Math.sqrt(relativeX * relativeX + relativeY * relativeY);

            recordedData.current.push({
                timestamp,
                faceMesh: faceLandmarks ? faceLandmarks.flat : null,
                sensors: { accel, gyro },
                
                // ส่ง Stats แทนจุดดิบ
                opticalFlowStats: {
                    ...flowStats,
                    variance: currentBgVariance
                },
                
                // ส่งค่าวิเคราะห์การเคลื่อนที่ (สำคัญสำหรับ Anti-Spoofing)
                motion_analysis: {
                    face_dx: faceDx,
                    face_dy: faceDy,
                    bg_dx: flowStats.avgX,
                    bg_dy: flowStats.avgY,
                    relative_magnitude: relativeMag // ค่าสูง = ดี (3D), ค่าต่ำ = รูปภาพ (2D)
                },

                bg_variance: currentBgVariance,
                image: imageBase64
            });
            
            if (recordedData.current.length % 30 === 0) {
                const hasImg = imageBase64 ? "📸 Img" : "❌ No Img";
                console.log(`Rec: ${recordedData.current.length} | Flow: ${flowStats.count} | RelMag: ${relativeMag.toFixed(2)} | ${hasImg}`);
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
            // STOP RECORDING
            setIsRecording(false);
            isRecordingRef.current = false;
            console.log("Stopped. Total Frames:", recordedData.current.length);
            
            if (recordedData.current.length > 0) {
                // แทนที่จะ upload เลย -> เปลี่ยนเป็นเข้าโหมด Review
                setIsReviewing(true);
            } else {
                setErrorMessage("No data collected.");
                setTimeout(() => setErrorMessage(null), 3000);
            }
        } else {
            // START RECORDING
            recordedData.current = [];
            setIsRecording(true);
            isRecordingRef.current = true;
            setUploadStatus('idle');
            console.log("Started Recording...");
        }
    };

    const handleConfirmUpload = () => {
        setIsReviewing(false); // ปิดหน้าต่าง Review
        uploadData({ type, scenario, motion, data: recordedData.current }); // ส่งข้อมูล
        
    };

    const handleDiscard = () => {
        setIsReviewing(false); // ปิดหน้าต่าง Review
        recordedData.current = []; // ลบข้อมูลทิ้ง
        console.log("Data discarded.");
    };

    const uploadData = async (payload: any) => {
        setUploadStatus('uploading');
        try {
            // อย่าลืมเปลี่ยน URL ตรงนี้ถ้าใช้ Ngrok
            const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'; 
            
            const res = await fetch(`${apiUrl}/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error("Upload failed");
            setUploadStatus('success');
            console.log("Success!");
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
                <p className="mt-4 text-lg">Initializing...</p>
            </div>
        );
    }

    return (
        <div className="relative w-screen h-[100dvh] overflow-hidden bg-black">
            <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-contain transform -scale-x-100" />
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain transform -scale-x-100" />
            
            {!hasPermission && (
                <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
                    <button onClick={handleConnect} className="bg-blue-600 px-8 py-4 rounded-xl font-bold text-white shadow-2xl">
                        Start Camera & Sensors
                    </button>
                </div>
            )}

            {hasPermission && (
                <>
                    {/* --- [เพิ่มใหม่] หน้าต่าง Review Mode (Overlay) --- */}
                    {isReviewing && (
                        <div className="absolute inset-0 bg-black/80 z-50 flex flex-col items-center justify-center space-y-6">
                            <div className="text-white text-2xl font-bold">Recording Finished</div>
                            <div className="text-gray-300">
                                Captured Frames: <span className="text-yellow-400 font-mono text-xl">{recordedData.current.length}</span>
                            </div>
                            
                            <div className="flex gap-4 mt-4">
                                {/* ปุ่มลบทิ้ง */}
                                <button 
                                    onClick={handleDiscard}
                                    className="px-8 py-4 bg-gray-600 hover:bg-gray-700 text-white rounded-xl font-bold text-lg"
                                >
                                    ❌ Discard & Retake
                                </button>
                                
                                {/* ปุ่มยืนยัน Save */}
                                <button 
                                    onClick={handleConfirmUpload}
                                    className="px-8 py-4 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold text-lg shadow-lg border-2 border-green-400"
                                >
                                    ✅ Confirm Save
                                </button>
                            </div>
                        </div>
                    )}
                    {/* ------------------------------------------- */}
                    {/* UI เดิม (ซ่อนตอน Review เพื่อไม่ให้กดซ้ำ) */}
                    {!isReviewing && (
                        <div className="absolute bottom-0 w-full z-40">
                            {/* Background Container: ทำเป็นแผ่น Card ลอยขึ้นมาจากด้านล่าง */}
                            <div className="bg-black/80 backdrop-blur-md rounded-t-3xl p-5 flex flex-col gap-4 border-t border-white/10 shadow-2xl pb-8">
                            
                            {/* Settings Section: จัดเรียง Input */}
                            <div className="flex flex-col gap-3">
                                {/* Row 1: Type (ยาวที่สุด ให้กินพื้นที่เต็ม) */}
                                <select
                                value={type}
                                onChange={(e) => setType(e.target.value as Type)}
                                disabled={isRecording}
                                className="bg-gray-800/80 text-white text-sm p-3 rounded-xl border border-gray-700 focus:outline-none focus:border-green-500 w-full appearance-none"
                                >
                                <option value="REAL">Real</option>
                                <option value="Spoof_2DScreen">Spoof - Photo Screen</option>
                                <option value="Spoof_VideoReplay">Spoof - Video Replay</option>
                                <option value="Spoof_TimeShift">Spoof - Time Shift</option>
                                </select>

                                {/* Row 2: Scenario & Motion (แบ่งครึ่ง 50-50) */}
                                <div className="grid grid-cols-2 gap-3">
                                <select
                                    value={scenario}
                                    onChange={(e) => setScenario(e.target.value as Scenario)}
                                    disabled={isRecording}
                                    className="bg-gray-800/80 text-white text-sm p-3 rounded-xl border border-gray-700 focus:outline-none focus:border-green-500 appearance-none"
                                >
                                    <option value="Normal">Normal</option>
                                    <option value="WhiteWall">White Wall</option>
                                    <option value="Backlight">Backlight</option>
                                    <option value="Walking">Walking</option>
                                </select>

                                <select
                                    value={motion}
                                    onChange={(e) => setMotion(e.target.value as Motion)}
                                    disabled={isRecording}
                                    className="bg-gray-800/80 text-white text-sm p-3 rounded-xl border border-gray-700 focus:outline-none focus:border-green-500 appearance-none"
                                >
                                    <option value="orbital_RL">Orbital R-L</option>
                                    <option value="orbital_LR">Orbital L-R</option>
                                    <option value="push-pull">Push-Pull</option>
                                    <option value="pull-push">Pull-Push</option>
                                    <option value="THT_R">THT R</option>
                                    <option value="THT_L">THT L</option>
                                </select>
                                </div>
                            </div>

                            {/* Action Section: ปุ่มอัด และ Toast */}
                            <div className="flex items-center justify-between mt-2">
                                {/* Empty div for spacing balance if needed, or Toast placement */}
                                <div className="flex-1">
                                    {/* ย้าย Toast มาตรงนี้เพื่อให้เห็นชัดเวลาอัด */}
                                    <Toast status={uploadStatus} message={errorMessage} />
                                </div>

                                {/* Record Button: ตรงกลาง ใหญ่ๆ กดง่าย */}
                                <button
                                onClick={toggleRecording}
                                className={`relative flex items-center justify-center w-20 h-20 rounded-full border-4 border-white/20 transition-all duration-200 active:scale-95 shadow-lg mx-4 ${
                                    isRecording ? 'bg-red-500/20' : 'bg-white/10'
                                }`}
                                >
                                <div
                                    className={`transition-all duration-300 rounded-md ${
                                    isRecording 
                                        ? 'w-8 h-8 bg-red-500 rounded-sm' // Stop icon style
                                        : 'w-16 h-16 bg-red-600 rounded-full border-2 border-white' // Record icon style
                                    }`}
                                />
                                </button>

                                <div className="flex-1"></div> {/* Spacer for symmetry */}
                            </div>
                            </div>
                        </div>
                    )}
                </>
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