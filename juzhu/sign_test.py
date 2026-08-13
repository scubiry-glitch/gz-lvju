import os
from sign_util import HmacAuth

if __name__ == "__main__":
    key_path = os.path.join(os.path.dirname(__file__), "hmac_secret.key")
    with open(key_path, "r") as f:
        secret_key = f.read().strip()
    # 实例化工具类
    auth = HmacAuth(secret_key=secret_key)

    # ==========================================
    # 场景一：你调用对方接口（作为客户端生成签名）
    # ==========================================
    original_data = {
        "order_ref": "GR20260729xxxx",
        "vendor_oid": "SP_88888",
        "status": "paid",
        "fee": 12800,
        "worker": {
            "name": "李师傅",
            "phone": "139****5678",
            "eta": "2026-07-29T14:00:00+08:00"
        },
        "cancel_reason": None, # Python 中为 None
        "remark": "" # 空字符串也会被过滤掉
    }

    # 生成最终需要发送出去的数据（包含 timestamp 和 sign）
    data_to_send = auth.generate_signature(original_data)
    
    print("【客户端】计算完毕，准备发送的数据：")
    import json
    print(json.dumps(data_to_send, ensure_ascii=False, indent=2))
    print("-" * 40)


    # ==========================================
    # 场景二：对方调用你的接口（作为服务端校验签名）
    # ==========================================
    # 假设你通过 FastAPI/Flask/Django 的 request.json 拿到了 data_to_send
    received_data = data_to_send.copy()

    # 进行校验
    is_valid, message = auth.verify_signature(received_data)
    print(f"【服务端】正常请求校验结果: {is_valid} - {message}")

    # 模拟黑客篡改了金额 (12800 -> 1)
    hacked_data = data_to_send.copy()
    hacked_data["fee"] = 1
    is_valid_2, message_2 = auth.verify_signature(hacked_data)
    print(f"【服务端】被篡改数据校验结果: {is_valid_2} - {message_2}")