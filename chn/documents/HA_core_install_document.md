# Home Assistant Core 源码部署与移植文档

## 1. 部署环境

- 系统：Ubuntu 22.04
- 方式：Home Assistant Core，源码 + Python 虚拟环境
- 目标：不依赖 Docker，完全本地运行，便于移植

---

## 2. 部署流程

### 2.1 基础依赖

```bash
sudo apt update
sudo apt install -y make build-essential libssl-dev zlib1g-dev \
libbz2-dev libreadline-dev libsqlite3-dev wget curl llvm \
libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev \
libffi-dev liblzma-dev libgdbm-dev libnss3-dev libzstd-dev

sudo apt install -y ffmpeg bluez libbluetooth-dev libturbojpeg0-dev
```

### 2.2 安装 pyenv 与 Python 3.14.2

```bash
curl -fsSL https://pyenv.run | bash

echo 'export PYENV_ROOT="$HOME/.pyenv"' >> ~/.bashrc
echo '[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"' >> ~/.bashrc
echo 'eval "$(pyenv init - bash)"' >> ~/.bashrc
source ~/.bashrc

pyenv update
pyenv install 3.14.2
```

### 2.3 编译 SQLite 3.43.2

Ubuntu 22.04 自带 SQLite 3.37.2，不满足 HA 要求（≥3.40.1）。

```bash
cd /tmp
wget https://www.sqlite.org/2023/sqlite-autoconf-3430200.tar.gz
tar xvfz sqlite-autoconf-3430200.tar.gz
cd sqlite-autoconf-3430200
./configure
make -j$(nproc)
sudo make install
sudo cp /usr/local/lib/*sql* /usr/lib/x86_64-linux-gnu/
sudo ldconfig
```

### 2.4 重新编译 Python 3.14.2

使 Python 链接新版 SQLite。

```bash
export LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH
export CPATH=/usr/local/include:$CPATH
export LIBRARY_PATH=/usr/local/lib:$LIBRARY_PATH

pyenv uninstall -f 3.14.2
pyenv install 3.14.2
```

验证：

```bash
~/.pyenv/versions/3.14.2/bin/python3.14 -c "import sqlite3; print(sqlite3.sqlite_version)"
# 应输出 3.43.2 或更高
```

### 2.5 获取源码并创建虚拟环境

```bash
cd ~
git clone https://github.com/home-assistant/core.git
cd core

pyenv local 3.14.2
python -m venv venv
source venv/bin/activate

echo 'export LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH' >> ~/core/venv/bin/activate
deactivate && source venv/bin/activate
```

### 2.6 安装 Home Assistant

```bash
python -m pip install --upgrade pip setuptools wheel -i https://pypi.org/simple
pip install -e . -i https://pypi.org/simple
```

### 2.7 生成翻译文件

```bash
python -m script.translations develop --all
```

### 2.8 配置端口

HA 的 HTTP 配置已迁移至 `.storage/http`，不再读取 `configuration.yaml` 中的 `http:` 段。

```bash
# 修改端口为 8124
sed -i 's/"server_port": 8123/"server_port": 8124/' ~/.homeassistant/.storage/http
```

确保 `configuration.yaml` 中**没有** `http:` 段。

### 2.9 启动

```bash
hass -c ~/.homeassistant
```

远程访问（Windows SSH 隧道）：

```powershell
ssh -L 8124:localhost:8124 chaos@10.124.39.205
```

浏览器访问：`http://localhost:8124`

---

## 3. 遇到的问题与解决办法

| 问题 | 现象 | 原因 | 解决办法 |
|---|---|---|---|
| ensurepip 缺失 | `venv` 创建失败 | 缺少 `python3-venv` | `sudo apt install python3.10-venv` |
| Python 版本过低 | HA 无法安装 | 系统默认 3.10，HA 要求 ≥3.14.2 | 使用 pyenv 安装 3.14.2 |
| `.python-version` 冲突 | `3.14.5 is not installed` | 文件指向未安装版本 | `pyenv local 3.14.2` |
| setuptools 找不到 | pip 报 `No matching distribution` | 清华镜像未同步 | 换官方源 `-i https://pypi.org/simple` |
| SQLite 版本低 | Recorder 启动失败 | 系统 SQLite 3.37.2 < 3.40.1 | 编译 SQLite 3.43.2 并重编译 Python |
| 数据库损坏 | `no such table: states` | 旧数据库结构不完整 | 删除 `home-assistant_v2.db*` 后重启 |
| 蓝牙权限不足 | `Missing NET_ADMIN/NET_RAW` | Python 解释器缺少能力 | `sudo setcap 'cap_net_raw,cap_net_admin+eip' $(readlink -f venv/bin/python)` |
| libturbojpeg 缺失 | 摄像头快照性能下降 | 未安装系统库 | `sudo apt install libturbojpeg0-dev` + `pip install PyTurboJPEG` |
| HTTP YAML 警告 | `HTTP YAML configuration is ignored` | 配置已迁移至 `.storage/http` | 删除 `configuration.yaml` 中的 `http:` 段 |
| onboarding KeyError | `component.onboarding.area.living_room` | 缺少翻译文件 | `python -m script.translations develop --all` |
| 端口冲突 | 8123 无法访问 | HA 实际监听 8124，浏览器缓存旧页面 | 统一使用 8124，清理缓存 |
| Core 不受支持 | `Unsupported installation method` | 官方自 2025.12 起不再支持 Core | 忽略或迁移至 Docker |

---

## 4. 后续移植策略

### 4.1 前提条件

目标系统需满足：

- Python ≥ 3.14.2
- SQLite ≥ 3.40.1
- 可安装以下系统库：
  - ffmpeg
  - libffi-dev
  - libssl-dev
  - libjpeg-dev / libturbojpeg0-dev
  - zlib1g-dev
  - bluez / libbluetooth-dev
  - libopenjp2-7
  - liblapack3 / libatlas-base-dev
  - build-essential / autoconf

### 4.2 移植步骤

1. **验证 Python 版本**，不满足则编译安装。
2. **安装系统依赖库**。
3. **确保 SQLite 版本 ≥ 3.40.1**，必要时源码编译并重编译 Python。
4. **克隆 `core` 仓库**。
5. **创建独立虚拟环境**（venv 或 uv）。
6. **执行 `pip install -e .`** 安装 HA 及依赖。
7. **检查平台校验**：若目标系统非 Linux/macOS/WSL，需修改 `homeassistant/__main__.py` 中的 `validate_os()`。
8. **处理权限**：蓝牙需 `NET_ADMIN`、`NET_RAW`；摄像头需 turbojpeg。
9. **配置端口**：通过 `.storage/http` 或 Web UI 修改。
10. **启动并验证**：`hass -c <配置目录>`。

### 4.3 长期建议

- Core 安装方式已不被官方支持，仅适合定制化移植和实验。
- 生产环境建议迁移至 **Home Assistant Container (Docker)**：
  - 挂载 `/config` 目录持久化配置。
  - 通过自定义 `Dockerfile` 固化系统级依赖。
  - 使用环境变量 `TZ`、`PUID`、`PGID` 等调整运行时行为。
  - 自定义组件放入 `/config/custom_components`。
- 移植时可将整个部署封装为脚本或镜像，便于在目标设备快速复现。