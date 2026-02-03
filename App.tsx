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

    // --- 5. Main Loop (FaceMesh + OpenCV + DRAWING) ---
    const onFaceMeshResults = useCallback((results: any) => {
        const canvasCtx = canvasRef.current?.getContext('2d', { willReadFrequently: true });
        if (!canvasCtx || !videoRef.current || !canvasRef.current) return;

        const { videoWidth, videoHeight } = videoRef.current;
        if (canvasRef.current.width !== videoWidth || canvasRef.current.height !== videoHeight) {
            canvasRef.current.width = videoWidth;
            canvasRef.current.height = videoHeight;
        }
        
        // --- 1. CLEAR CANVAS (ล้างหน้าจอทุกเฟรม เพื่อวาดใหม่) ---
        canvasCtx.clearRect(0, 0, videoWidth, videoHeight);
        
        let faceLandmarks: FaceMeshResult | null = null;
        let faceBoundingBox = null;

        // --- 2. DRAWING LOGIC (วาดตลอดเวลา ไม่สนว่าอัดอยู่ไหม) ---
        if (results.multiFaceLandmarks && results.multiFaceLandmarks[0]) {
            const landmarks = results.multiFaceLandmarks[0];
            
            // เตรียมข้อมูล
            faceLandmarks = {
                all: landmarks,
                specific: FACEMESH_LANDMARK_INDICES.map(i => landmarks[i]),
                flat: FACEMESH_LANDMARK_INDICES.flatMap(i => [landmarks[i].x, landmarks[i].y, landmarks[i].z])
            };

            // A. วาดโครงสร้างหน้า (468 จุด) - สีฟ้าจางๆ
            canvasCtx.fillStyle = 'rgba(0, 255, 255, 0.4)'; // Cyan, โปร่งแสง
            landmarks.forEach((lm: Point) => {
                const x = lm.x * videoWidth;
                const y = lm.y * videoHeight;
                canvasCtx.beginPath();
                canvasCtx.arc(x, y, 1, 0, 2 * Math.PI); // จุดเล็ก
                canvasCtx.fill();
            });

            // B. วาดจุดสำคัญ (28 จุด) - สีเขียวสว่าง
            canvasCtx.fillStyle = '#00FF00'; // Green

            faceLandmarks.specific.forEach((lm: Point) => {
                const x = lm.x * videoWidth;
                const y = lm.y * videoHeight;
                canvasCtx.beginPath();
                canvasCtx.arc(x, y, 2, 0, 2 * Math.PI); // จุดใหญ่
                canvasCtx.fill();
                canvasCtx.stroke();
            });

            // คำนวณ Bounding Box สำหรับ OpenCV
            const xs = landmarks.map((l: Point) => l.x);
            const ys = landmarks.map((l: Point) => l.y);
            faceBoundingBox = {
                xMin: Math.min(...xs), xMax: Math.max(...xs),
                yMin: Math.min(...ys), yMax: Math.max(...ys),
            };
        }

        // --- 3. OpenCV Processing & bg_variance Calculation ---
        const cv = (window as any).cv;
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
                // สร้าง Mat จาก Video (แต่ไม่วาดทับลง Canvas ที่เราวาดจุดไปแล้ว)
                currentFrame = new cv.Mat(videoHeight, videoWidth, cv.CV_8UC4);
                
                // *Hack*: เราต้องดึงภาพจาก Video element มาวิเคราะห์ แต่ระวังอย่าไป drawImage ทับจุดที่เราวาด
                // วิธีคือ: สร้าง canvas ชั่วคราว หรือใช้ OffscreenCanvas แต่ง่ายสุดคือ
                // ยอมให้วิเคราะห์จาก Canvas เดิมก่อนวาดจุด (แต่เราวาดไปแล้ว)
                // ดังนั้น: ใช้เทคนิค drawImage จาก video ลงบน Mat โดยตรงผ่าน temporary canvas หรือ
                // เพื่อความง่าย: ให้ยอมรับว่า OpenCV จะ process ภาพที่อาจจะไม่มีจุด (เพราะเราดึงจาก videoRef)
                
                // ใช้ canvasCtx ชั่วคราวในการดึง pixel data (อันนี้อาจจะกิน resource นิดหน่อย)
                // แต่เพื่อความชัวร์ เราจะดึงจาก videoRef โดยตรงไม่ได้ ต้องผ่าน canvas
                // เพื่อประสิทธิภาพ เราจะข้ามขั้นตอนการวาด video ลง canvas หลัก 
                // แต่จะใช้ offscreen logic ถ้าทำได้. แต่ในที่นี้ขอใช้วิธีดึงภาพจาก video ลง currentFrame ตรงๆ
                
                // สร้าง Canvas ชั่วคราวใน Memory เพื่อดึงภาพจาก Video (ไม่ให้กวนหน้าจอหลัก)
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = videoWidth;
                tempCanvas.height = videoHeight;
                const tempCtx = tempCanvas.getContext('2d');
                if(tempCtx) {
                    tempCtx.drawImage(videoRef.current, 0, 0, videoWidth, videoHeight);
                    const frameImageData = tempCtx.getImageData(0, 0, videoWidth, videoHeight);
                    currentFrame.data.set(frameImageData.data);
                }

                currentGray = new cv.Mat();
                cv.cvtColor(currentFrame, currentGray, cv.COLOR_RGBA2GRAY);

                if (prevGray.current) {
                    // 1. Initial Points Detection
                    if (!backgroundPoints.current || backgroundPoints.current.rows === 0) {
                        mask = new cv.Mat.zeros(videoHeight, videoWidth, cv.CV_8U);
                        if (faceBoundingBox) {
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

                    // 2. Optical Flow
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

                        for (let i = 0; i < st.length; i++) {
                            if (st[i] === 1) {
                                goodNewPoints.push(p1[i * 2], p1[i * 2 + 1]);
                                const xOld = p0[i * 2];
                                const yOld = p0[i * 2 + 1];
                                const xNew = p1[i * 2];
                                const yNew = p1[i * 2 + 1];
                                const dist = Math.sqrt(Math.pow(xNew - xOld, 2) + Math.pow(yNew - yOld, 2));
                                movements.push(dist);
                            }
                        }

                        if (movements.length > 0) {
                            const mean = movements.reduce((a, b) => a + b, 0) / movements.length;
                            const sqDiffs = movements.map(val => Math.pow(val - mean, 2));
                            currentBgVariance = sqDiffs.reduce((a, b) => a + b, 0) / movements.length;
                        }

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
            const opticalFlowPoints = backgroundPoints.current ? Array.from(backgroundPoints.current.data32F as number[]) : [];
            
            // --- [แก้ใหม่ล่าสุด] บังคับจับภาพ (Simple Capture) ---
            let imageBase64 = null;
            
            // ไม่ต้องเช็ค readyState เยอะ เอาแค่มี video และขนาดไม่เป็น 0 ก็พอ
            if (videoRef.current && videoRef.current.videoWidth > 0) {
                try {
                    const videoEl = videoRef.current;
                    const tempCanvas = document.createElement('canvas');
                    
                    // ลดขนาดภาพลง (480px) เพื่อให้ส่งทันและไฟล์ไม่ใหญ่เกินไป
                    const scale = 480 / videoEl.videoWidth;
                    tempCanvas.width = 480;
                    tempCanvas.height = videoEl.videoHeight * scale;
                    
                    const tempCtx = tempCanvas.getContext('2d');
                    if (tempCtx) {
                        tempCtx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
                        // แปลงเป็น Base64 (.jpg)
                        imageBase64 = tempCanvas.toDataURL('image/jpeg', 0.7);
                    }
                } catch (err) {
                    console.error("❌ Capture Error:", err);
                }
            } else {
                console.warn("⚠️ Video not ready for capture");
            }
            // ----------------------------------------------------

            recordedData.current.push({
                timestamp,
                faceMesh: faceLandmarks ? faceLandmarks.flat : null,
                sensors: { accel, gyro },
                opticalFlow: opticalFlowPoints,
                bg_variance: currentBgVariance,
                image: imageBase64 // <--- ส่งรูป
            });
            
            // --- Log เช็คหน้างานทันที ---
            if (recordedData.current.length % 30 === 0) {
                // ถ้า imageBase64 มีค่า มันจะแสดงคำว่า "📸 Got Image"
                // ถ้าไม่มี จะแสดง "❌ No Image"
                const hasImg = imageBase64 ? "📸 Got Image" : "❌ No Image";
                console.log(`Rec: ${recordedData.current.length} frames | ${hasImg}`);
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
        uploadData({ scenario, data: recordedData.current }); // ส่งข้อมูล
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
        <div className="relative w-screen h-screen overflow-hidden bg-black">
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
                        <div className="absolute bottom-0 w-full p-6 bg-black/60 backdrop-blur-md flex items-center gap-4 z-40">
                            <select 
                                value={scenario} 
                                onChange={(e) => setScenario(e.target.value as Scenario)}
                                disabled={isRecording}
                                className="bg-gray-800 text-white p-3 rounded-lg flex-1"
                            >
                                <option value="REAL_Normal">Real - Normal</option>
                                <option value="REAL_WhiteWall">Real - White Wall</option>
                                <option value="REAL_Backlight">Real - Backlight</option>
                                <option value="REAL_Walking">Real - Walking</option>
                                <option value="Spoof_2DWall">Spoof - Photo Wall</option>
                                <option value="Spoof_2DScreen">Spoof - Photo Screen</option>
                                <option value="Spoof_VideoReplay">Spoof - Video Replay</option>
                            </select>

                            <button onClick={toggleRecording} className={`p-5 rounded-full ${isRecording ? 'bg-red-500' : 'bg-green-500'}`}>
                                {isRecording ? <StopIcon /> : <RecordIcon />}
                            </button>

                            <div className="flex-1 flex justify-end">
                                <Toast status={uploadStatus} message={errorMessage} />
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