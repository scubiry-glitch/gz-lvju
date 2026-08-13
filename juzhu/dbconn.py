"""juzhu MySQL 连接层 —— 提供 sqlite3 兼容 API 表面。

上层（server.py / db.py / jiazheng_db.py）沿用 sqlite3 风格：
    conn.execute(sql, params)    # ? 占位符
    conn.executescript(script)
    conn.commit() / close() / row_factory 赋值
    cursor.fetchone() / fetchall() / lastrowid / rowcount
    Row 行对象：row[0] / row["name"] / keys() / dict(row)

本层内部走 pymysql，负责方言适配：
- `?` → `%s` 占位符翻译（单/双引号字面量内的 `?` 不翻译）
- MySQL 保留字列名自动加反引号：settings.key、jz_orders.desc
  （仅匹配小写独立单词，ORDER BY 的大写 DESC、PRIMARY KEY 不受影响）
- `PRAGMA foreign_keys = ON` → no-op；`PRAGMA table_info(X)` → information_schema 映射
- `SELECT ... FROM sqlite_master` → information_schema.TABLES 映射

配置读取环境变量（由 tp_client.load_dotenv 注入）：
    JUZHU_DB_HOST / JUZHU_DB_PORT / JUZHU_DB_USER / JUZHU_DB_PASSWORD / JUZHU_DB_NAME
"""
import os
import re

import pymysql

# ── 配置 ──────────────────────────────────────────────────────

def load_db_config(environ=None):
    env = environ if environ is not None else os.environ
    return {
        "host": env.get("JUZHU_DB_HOST") or "127.0.0.1",
        "port": int(env.get("JUZHU_DB_PORT") or 3306),
        "user": env.get("JUZHU_DB_USER") or "root",
        "password": env.get("JUZHU_DB_PASSWORD") or "",
        "database": env.get("JUZHU_DB_NAME") or "juzhu",
    }


def connect():
    cfg = load_db_config()
    raw = pymysql.connect(
        host=cfg["host"],
        port=cfg["port"],
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        charset="utf8mb4",
        autocommit=False,  # 与 sqlite3 隐式事务语义一致：上层显式 commit
    )
    return MysqlConn(raw)


# ── SQL 翻译纯函数 ────────────────────────────────────────────

# 切分 token：`?` 占位符 | 单引号字面量（含 '' 转义） | 双引号字面量（含 "" 转义）
_TOKEN_RE = re.compile(r"(\?|'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\")")
# 保留字列名（仅小写独立单词；大写 KEY/DESC 属语法关键字，不匹配）
_RESERVED_COL_RE = re.compile(r"\b(key|desc)\b")


def translate_placeholders(sql, params=()):
    """`?` 占位符 → pymysql 的 `%s`；引号字面量内的 `?` 保持原样。"""
    out = []
    for part in _TOKEN_RE.split(sql):
        out.append("%s" if part == "?" else part)
    return "".join(out), params


def quote_reserved_words(sql):
    """settings.key / jz_orders.desc 为 MySQL 保留字：非字面量段内加反引号。"""
    out = []
    for part in _TOKEN_RE.split(sql):
        if part and part[0] in ("'", '"'):
            out.append(part)
        else:
            out.append(_RESERVED_COL_RE.sub(lambda m: "`%s`" % m.group(1), part))
    return "".join(out)


def split_script(script):
    """executescript 用：按 `;` 切分（本项目的 SQL 文件无存储过程/触发器，朴素切分安全）。"""
    return [s.strip() for s in (script or "").split(";") if s.strip()]


_PRAGMA_RE = re.compile(r"^\s*PRAGMA\s+([A-Za-z_]+)\s*(?:\(([^)]*)\))?.*$", re.S)


def pragma_to_sql(sql):
    """PRAGMA 拦截：返回 (mysql_sql, params)；no-op PRAGMA 返回 ('__noop__', None)；
    非 PRAGMA 语句返回 None。"""
    m = _PRAGMA_RE.match((sql or "").strip())
    if not m:
        return None
    name = m.group(1).lower()
    if name == "foreign_keys":
        return ("__noop__", None)  # MySQL 外键恒开
    if name == "table_info":
        table = (m.group(2) or "").strip().strip("'\"")
        return (
            "SELECT ORDINAL_POSITION-1 AS cid, COLUMN_NAME AS name, DATA_TYPE AS type, "
            "IF(IS_NULLABLE='NO',1,0) AS notnull, COLUMN_DEFAULT AS dflt_value, "
            "IF(COLUMN_KEY='PRI',1,0) AS pk "
            "FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s "
            "ORDER BY ORDINAL_POSITION",
            (table,),
        )
    raise ValueError("不支持的 PRAGMA 语句: %s" % (sql or "").strip())


def sqlite_master_to_sql(sql):
    """sqlite_master 查询拦截：映射到 information_schema.TABLES；不含则返回 None。"""
    if "sqlite_master" in (sql or "").lower():
        return (
            "SELECT TABLE_NAME AS name, 'table' AS type "
            "FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
            (),
        )
    return None


# ── 行对象 / 游标 / 连接 ──────────────────────────────────────

class Row:
    """sqlite3.Row 兼容行：int/str 下标、keys()、len/iter/in、dict(row)。"""

    __slots__ = ("_keys", "_data")

    def __init__(self, keys, data):
        if keys and isinstance(keys[0], (tuple, list)):  # pymysql description 形状
            keys = [k[0] for k in keys]
        self._keys = list(keys)
        self._data = list(data)

    def __getitem__(self, idx):
        if isinstance(idx, (int, slice)):
            return self._data[idx]
        return self._data[self._keys.index(idx)]

    def __len__(self):
        return len(self._data)

    def __iter__(self):
        return iter(self._data)

    def keys(self):
        return list(self._keys)

    def __contains__(self, key):
        return key in self._keys

    def __repr__(self):
        return "Row(%r)" % (self._data,)


class _MysqlCursor:
    """pymysql 游标包装：fetchone/fetchall 返回 Row，暴露 lastrowid/rowcount。"""

    def __init__(self, raw):
        self._raw = raw

    def fetchone(self):
        row = self._raw.fetchone()
        return None if row is None else Row(self._raw.description, row)

    def fetchall(self):
        desc = self._raw.description
        return [Row(desc, r) for r in self._raw.fetchall()]

    @property
    def lastrowid(self):
        return self._raw.lastrowid

    @property
    def rowcount(self):
        return self._raw.rowcount


class _EmptyCursor(_MysqlCursor):
    """no-op PRAGMA 的空游标。"""

    def __init__(self):
        self._raw = None

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    lastrowid = 0
    rowcount = -1


class _ConnCursor:
    """sqlite3.Cursor 兼容代理：execute 返回可 fetch 的游标（供 seed 脚本使用）。"""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return self._conn.execute(sql, params)

    def executescript(self, script):
        return self._conn.executescript(script)


class MysqlConn:
    """pymysql 连接包装：对上层暴露 sqlite3.Connection 兼容接口。"""

    def __init__(self, raw):
        self._raw = raw
        self.row_factory = None  # 兼容 sqlite3 风格赋值；统一返回 Row，赋值被忽略

    def execute(self, sql, params=()):
        sql_text = (sql or "").strip()
        # PRAGMA / sqlite_master 拦截
        if sql_text[:6].upper() == "PRAGMA":
            mapped = pragma_to_sql(sql_text)
            if mapped is not None:
                if mapped[0] == "__noop__":
                    return _EmptyCursor()
                sql_text, params = mapped
        elif "sqlite_master" in sql_text.lower():
            mapped = sqlite_master_to_sql(sql_text)
            if mapped is not None:
                sql_text, params = mapped
        elif sql_text.lower().startswith("select last_insert_rowid"):
            sql_text = "SELECT LAST_INSERT_ID()"
        # 占位符翻译 + 保留字加反引号
        sql_text, _ = translate_placeholders(sql_text, params)
        sql_text = quote_reserved_words(sql_text)
        cur = self._raw.cursor()
        cur.execute(sql_text, params)
        return _MysqlCursor(cur)

    def executescript(self, script):
        for stmt in split_script(script):
            self.execute(stmt)
        return self

    def cursor(self):
        """sqlite3 风格 cursor()：返回代理，execute 转发到本连接。"""
        return _ConnCursor(self)

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        try:
            self._raw.close()
        except Exception:
            pass
