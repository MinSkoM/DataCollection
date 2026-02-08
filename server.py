import os
import json
import time
import base64  # <--- เพิ่ม import นี้
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

SAVE_FOLDER = "collected_data"
if not os.path.exists(SAVE_FOLDER):
    os.makedirs(SAVE_FOLDER)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_data():
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No data received"}), 400

        scenario = data.get("scenario", "unknown")
        type = data.get("type", "unknown")
        motion = data.get("motion", "unknown")
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        
        # สร้างโฟลเดอร์สำหรับรอบการอัดนี้โดยเฉพาะ (เช่น collected_data/spoof_2023...)
        session_folder = f"{SAVE_FOLDER}/{type}_{scenario}_{motion}_{timestamp}"
        if not os.path.exists(session_folder):
            os.makedirs(session_folder)
            
        # สร้างโฟลเดอร์เก็บรูปภาพข้างใน
        images_folder = f"{session_folder}/images"
        if not os.path.exists(images_folder):
            os.makedirs(images_folder)

        frames = data.get("data", [])
        print(f"🖼️ Processing {len(frames)} frames...")

        saved_images_count = 0
        for i, frame in enumerate(frames):
            img_base64 = frame.get("image")
            
            if img_base64 and len(img_base64) > 100: # เช็คว่ามีข้อมูลรูปจริง (ไม่ใช่สตริงสั้นๆ)
                try:
                    # ตัด Header ออก
                    if "," in img_base64:
                        header, encoded = img_base64.split(",", 1)
                    else:
                        encoded = img_base64

                    # แปลงและบันทึก
                    img_data = base64.b64decode(encoded)
                    img_filename = f"frame_{i:04d}.jpg"
                    img_path = f"{images_folder}/{img_filename}"
                    
                    with open(img_path, "wb") as f_img:
                        f_img.write(img_data)
                    
                    # อัปเดตชื่อไฟล์ใน object เพื่อบันทึกทับใน JSON ตัวสุดท้าย
                    frame["image"] = img_filename
                    saved_images_count += 1
                    
                except Exception as img_err:
                    print(f"⚠️ Frame {i} error: {img_err}")
                    frame["image"] = "error"
            else:
                frame["image"] = None # ไม่มีรูป

        # 4. บันทึก JSON ตัวสมบูรณ์ (ที่เปลี่ยน Base64 เป็นชื่อไฟล์แล้ว)
        final_json_path = f"{session_folder}/data.json"
        with open(final_json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)

        print(f"✅ Saved Session: {session_folder}")
        return jsonify({"status": "success", "folder": session_folder}), 200

    except Exception as e:
        print(f"❌ Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    # เพิ่ม max_content_length เพราะส่งรูปไฟล์จะใหญ่ขึ้น
    app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # ให้ส่งได้สูงสุด 100MB ต่อครั้ง
    print("Starting Flask Server with Image Support...")
    app.run(host='0.0.0.0', port=5000, debug=True)