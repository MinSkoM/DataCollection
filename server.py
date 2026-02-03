# server.py
# รันบนคอมพิวเตอร์เพื่อรอรับข้อมูลจากมือถือ
import os
import json
import time
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS

app = Flask(__name__)
CORS(app) # อนุญาตให้มือถือส่งข้อมูลเข้ามาได้

# สร้าง Folder เก็บข้อมูลถ้ายังไม่มี
SAVE_FOLDER = "collected_data"
if not os.path.exists(SAVE_FOLDER):
    os.makedirs(SAVE_FOLDER)

# โหลดหน้า HTML
@app.route('/')
def index():
    return render_template('index.html')

# API สำหรับรับข้อมูล JSON และบันทึกลงเครื่อง
@app.route('/upload', methods=['POST'])
def upload_data():
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No data received"}), 400

        # สร้างชื่อไฟล์ตาม Timestamp (ผมเพิ่มวินาที %S ให้ด้วย กันไฟล์ทับกัน)
        timestamp = time.strftime("%m%d_%H%M%S")
        
        # --- [จุดที่แก้ไข] --- 
        # ดึง scenario จากชั้นแรกสุดเลย (เพราะ App.tsx ส่งมาแบบ { scenario: '...', data: [...] })
        scenario = data.get("scenario", "unknown") 
        # -------------------

        filename = f"{SAVE_FOLDER}/{scenario}_{timestamp}.json"

        # เขียนไฟล์ลง Hard Disk ของคอมพิวเตอร์ทันที!
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)

        print(f"✅ Saved: {filename}")
        return jsonify({"status": "success", "filename": filename}), 200

    except Exception as e:
        print(f"❌ Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    # รัน Server ที่ Port 5000
    print("Starting Flask Server...")
    app.run(host='0.0.0.0', port=5000, debug=True)