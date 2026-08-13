import hashlib
import hmac
import time

class HmacAuth:
    def __init__(self, secret_key: str):
        """
        初始化签名工具类
        :param secret_key: 双方共享的密钥
        """
        self.secret_key = secret_key.encode('utf-8')

    def _flatten_and_filter(self, data: dict, prefix: str = '') -> dict:
        """
        递归展平嵌套字典，并过滤掉值为 None 或空字符串的字段
        """
        flat_dict = {}
        for k, v in data.items():
            # 过滤掉 None 和空字符串
            if v is None or v == "":
                continue
            
            # 如果在根目录，不用加前缀；如果是嵌套字典，使用 parent.child 格式
            key_name = f"{prefix}.{k}" if prefix else k
            
            if isinstance(v, dict):
                # 递归展平嵌套字典
                flat_dict.update(self._flatten_and_filter(v, key_name))
            else:
                flat_dict[key_name] = str(v)
        return flat_dict

    def _build_string_to_sign(self, flat_params: dict) -> str:
        """
        将展平后的字典按 Key 字典序排序，并拼接成 a=1&b=2 格式
        """
        sorted_keys = sorted(flat_params.keys())
        return "&".join([f"{k}={flat_params[k]}" for k in sorted_keys])

    def generate_signature(self, request_body: dict) -> dict:
        """
        【客户端使用】：生成带有签名的请求体
        :param request_body: 原始请求体参数
        :return: 包含签名和时间戳的请求数据字典
        """
        # 1. 复制一份数据，避免修改原对象，并剔除可能存在的 sign 字段
        payload = request_body.copy()
        payload.pop("sign", None)

        # 2. 生成当前时间戳（毫秒）并混入参数中
        timestamp = int(time.time() * 1000)
        
        # 3. 展平并过滤参数
        flat_params = self._flatten_and_filter(payload)
        
        # 4. 将 timestamp 强制加入待签名字段中
        flat_params["timestamp"] = str(timestamp)

        # 5. 排序并拼接成待签名字符串
        string_to_sign = self._build_string_to_sign(flat_params)

        # 6. 计算 HMAC-SHA256
        sign = hmac.new(
            self.secret_key,
            string_to_sign.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()

        # 7. 返回结果，将 timestamp 和 sign 放入 payload 中方便发送
        payload["timestamp"] = timestamp
        payload["sign"] = sign
        
        return payload

    def verify_signature(self, request_body: dict, expire_window_ms: int = 300000) -> tuple:
        """
        【服务端使用】：校验收到的请求签名是否合法
        :param request_body: 收到的完整请求体（需包含 timestamp 和 sign）
        :param expire_window_ms: 允许的时间戳误差（默认 5 分钟 = 300000 毫秒）
        :return: (是否通过校验: bool, 提示信息: str)
        """
        # 1. 提取签名和时间戳
        payload = request_body.copy()
        client_sign = payload.pop("sign", None)
        timestamp_str = payload.pop("timestamp", None)

        if not client_sign or not timestamp_str:
            return False, "缺失签名(sign)或时间戳(timestamp)参数"

        # 2. 防重放校验：时间戳是否在合理范围内
        try:
            timestamp = int(timestamp_str)
        except ValueError:
            return False, "时间戳格式错误"

        current_time = int(time.time() * 1000)
        if abs(current_time - timestamp) > expire_window_ms:
            return False, f"请求已过期 (当前系统时间差异超出 {expire_window_ms}ms)"

        # 3. 展平并过滤参数
        flat_params = self._flatten_and_filter(payload)
        
        # 将接收到的时间戳加入签名计算
        flat_params["timestamp"] = str(timestamp)

        # 4. 排序并拼接成待签名字符串
        string_to_sign = self._build_string_to_sign(flat_params)

        # 5. 计算期望的 HMAC-SHA256
        expected_sign = hmac.new(
            self.secret_key,
            string_to_sign.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()

        # 6. 安全比对签名（使用 compare_digest 防止时序攻击）
        if hmac.compare_digest(expected_sign.lower(), client_sign.lower()):
            return True, "校验通过"
        
        return False, "签名校验失败"