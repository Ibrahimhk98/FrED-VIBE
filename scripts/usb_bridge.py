"""Local wired fallback when the browser cannot enumerate the USB serial adapter."""
import argparse
import asyncio
import json

import serial
from serial.tools import list_ports
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed


def choose_port(requested):
    if requested:
        return requested
    ports = [p.device for p in list_ports.comports() if p.vid is not None]
    if len(ports) != 1:
        raise ValueError("Specify --port; detected USB serial ports: " + (", ".join(ports) or "none"))
    return ports[0]


async def run(port):
    busy = False

    async def connect(socket):
        nonlocal busy
        if busy:
            await socket.close(1008, "USB bridge already has a dashboard connected")
            return
        busy = True
        device = None
        tasks = []
        try:
            device = serial.Serial(port=None, baudrate=230400, timeout=0.02, write_timeout=1)
            device.dtr = device.rts = False
            device.port = port
            device.open()
            # Some native CDC hosts toggle reset despite the requested line state.
            # Drain boot output and pre-connection backlog before exposing a stream.
            ready_at = asyncio.get_running_loop().time() + 1
            while asyncio.get_running_loop().time() < ready_at:
                await asyncio.to_thread(device.read, 16384)

            async def read():
                aligned = False
                while True:
                    chunk = await asyncio.to_thread(device.read, 16384)
                    if chunk and not aligned:
                        _, boundary, chunk = chunk.partition(b'\n')
                        if not boundary:
                            continue
                        aligned = True
                    if chunk:
                        # Firmware output is ASCII JSONL; preserve partial lines.
                        await socket.send(chunk.decode("ascii", errors="replace"))

            async def write():
                async for message in socket:
                    if not isinstance(message, str):
                        raise ValueError("Commands must be JSON text")
                    command = json.loads(message)
                    if not isinstance(command, dict) or not isinstance(command.get("cmd"), str):
                        raise ValueError("Invalid command")
                    payload = (json.dumps(command, ensure_ascii=False) + "\n").encode("utf-8")
                    if len(payload) > 768:
                        raise ValueError("Command exceeds 768 bytes")
                    await asyncio.to_thread(device.write, payload)

            tasks = [asyncio.create_task(read()), asyncio.create_task(write())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except ConnectionClosed:
            pass
        except (serial.SerialException, OSError, ValueError):
            # Do not log command payloads, which may contain Wi-Fi credentials.
            await socket.close(1011, "USB connection interrupted or invalid command")
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if device:
                device.close()
            busy = False

    # Bind only to loopback and accept only the local dashboard's browser origin.
    async with serve(connect, "127.0.0.1", 8766,
                     origins=["http://localhost:8000", "http://127.0.0.1:8000"],
                     max_size=768, max_queue=8):
        print(f"USB bridge ready for {port}. Open http://localhost:8000 and choose Connect USB bridge.", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Serial device path; auto-selected when exactly one USB adapter is connected")
    args = parser.parse_args()
    try:
        selected = choose_port(args.port)
    except ValueError as error:
        parser.error(str(error))
    try:
        asyncio.run(run(selected))
    except KeyboardInterrupt:
        pass
