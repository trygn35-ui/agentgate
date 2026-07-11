"""为打包版隔离测试提供本地模型列表端点。"""

import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ModelHandler(BaseHTTPRequestHandler):
    """响应隔离烟测请求，不记录请求头、正文或 Key。"""

    protocol_version = "HTTP/1.1"

    def do_HEAD(self) -> None:
        """为无凭据健康探测返回可达状态。"""

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        """返回固定模型列表；其他路径返回 404。"""

        path = self.path.split("?", maxsplit=1)[0]
        if path.endswith("/v1/models"):
            body = json.dumps(
                {"data": [{"id": "claude-smoke-model"}]},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        """返回当前上游路径标识，供网关热切换烟测使用。"""

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length:
            self.rfile.read(content_length)
        path = self.path.split("?", maxsplit=1)[0]
        if path.endswith("/v1/responses"):
            route = "b" if "/b/" in path else "a"
            body = json.dumps({"route": route}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, message: str, *args: object) -> None:
        """将标准请求日志降为调试级别，避免输出凭据相关上下文。"""

        logging.getLogger(__name__).debug(message, *args)


def main() -> None:
    """解析监听端口并运行可由测试进程终止的本地服务器。"""

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), ModelHandler)
    server.serve_forever(poll_interval=0.1)


if __name__ == "__main__":
    main()
