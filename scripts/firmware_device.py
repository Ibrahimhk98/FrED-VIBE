"""USB inventory, configuration readback and verified A3 flashing for the local UI."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time

import serial
from serial.tools import list_ports

REPO = Path(__file__).resolve().parent.parent
PACKAGE = REPO / 'firmware'
sys.path.insert(0, str(Path.home() / '.platformio/packages/tool-esptoolpy'))
import esptool
from esptool.targets.esp32s3 import ESP32S3ROM


class A3ROM(ESP32S3ROM):
    # PlatformIO's esptool 4.5.1 uses the wrong S3 WDT register (+0x90).
    # Backport Espressif 6fd91af: otherwise a USB reset leaves the watchdog
    # running and it resets the chip partway through a full image write.
    # https://github.com/espressif/esptool/commit/6fd91af
    RTC_CNTL_WDTCONFIG0_REG = ESP32S3ROM.RTCCNTL_BASE_REG + 0x0098


def inventory():
    return [{'path': p.device, 'serial': p.serial_number or '', 'description': p.description,
             'deviceId': device_id(p.serial_number)} for p in list_ports.comports()
            if p.vid == 0x303A and p.pid == 0x1001]


def device_id(value):
    compact = re.sub('[^a-fA-F0-9]', '', value or '')
    return bytes.fromhex(compact)[::-1].hex() if len(compact) == 12 else ''


def selected_port(path, expected=''):
    match = next((p for p in inventory() if p['path'] == path), None)
    if not match:
        raise ValueError('ESP32 USB port unavailable. Connect USB with SW1 ON; hold BOOT, press RESET, release BOOT, then check again.')
    if expected and match['deviceId'] and expected != match['deviceId']:
        raise ValueError('The selected USB board does not match the connected kit.')
    return match


def open_serial(path):
    device = serial.Serial(port=None, baudrate=115200, timeout=0.02, write_timeout=2)
    device.dtr = device.rts = False
    device.port = path
    for attempt in range(5):
        try:
            device.open()
            break
        except serial.SerialException:
            if attempt == 4:
                raise
            time.sleep(1)
    return device


def read_configuration_from(device, expected='', seconds=7):
    pending = b''
    deadline = time.monotonic() + seconds
    next_request = time.monotonic() + 1
    device.timeout = 0.02
    while time.monotonic() < deadline:
        if time.monotonic() >= next_request:
            device.write(b'{"cmd":"get_config"}\n')
            next_request = time.monotonic() + 1
        pending += device.read(16384)
        lines = pending.split(b'\n'); pending = lines.pop()[-65536:]
        for line in lines:
            try:
                message = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(message, dict) and message.get('type') == 'configuration':
                if expected and message.get('device_id') != expected:
                    raise ValueError('USB configuration came from a different board.')
                return message
    raise ValueError('No running firmware response. Release BOOT and press RESET once, then read the version again.')


def read_configuration(path, expected='', seconds=7):
    selected_port(path, expected)
    with open_serial(path) as device:
        return read_configuration_from(device, expected, seconds)


def load_release(release_id):
    manifest = json.loads((PACKAGE / 'manifest.json').read_text())
    if manifest.get('id') != release_id:
        raise ValueError('Available firmware changed. Check again before flashing.')
    if (manifest.get('hardware'), manifest.get('chip'), manifest.get('flashSize')) != ('FrED PAL A3', 'esp32s3', 8388608):
        raise ValueError('Incompatible firmware package')
    images = manifest.get('images', [])
    if [i['offset'] for i in images] != [0, 0x8000, 0xE000, 0x10000]:
        raise ValueError('Unexpected flash layout')
    for image in images:
        path = (PACKAGE / image['file']).resolve()
        if PACKAGE.resolve() not in path.parents:
            raise ValueError('Invalid image path')
        data = path.read_bytes()
        if len(data) != image['size'] or hashlib.sha256(data).hexdigest() != image['sha256']:
            raise ValueError('Firmware checksum mismatch; rebuild the package')
        image['path'] = str(path)
    return manifest


def flash(path, release_id, expected=''):
    manifest = load_release(release_id)
    port = selected_port(path, expected)
    configuration = None
    error = ''
    # Native USB serial/JTAG must open with DTR/RTS deasserted on macOS.
    with open_serial(path) as device:
        esp = A3ROM(device)
        esp.connect('usb_reset', attempts=3)
        actual = bytes(esp.read_mac())[::-1].hex()
        if (expected and actual != expected) or (port['deviceId'] and actual != port['deviceId']):
            raise ValueError('ROM MAC does not match the selected board; no firmware was written.')
        esp.flash_spi_attach(0)
        if (esp.flash_id() >> 16) & 0xff != 0x17:
            raise ValueError('FrED PAL A3 requires 8 MB flash; no firmware was written.')
        args = ['--chip', 'esp32s3', '--port', path, '--baud', '115200', '--before', 'no_reset',
                '--after', 'hard_reset', '--no-stub', 'write_flash', '--flash_mode', 'dio',
                '--flash_freq', '80m', '--flash_size', '8MB']
        for image in manifest['images']:
            args.extend([hex(image['offset']), image['path']])
        # esptool verifies each image's flash digest before returning successfully.
        esptool.main(args, esp=esp)
        print('PAL_EVENT ' + json.dumps({'stage': 'verifying', 'detail': 'Flash hashes verified. Waiting for the application…'}), flush=True)
        # Keep the existing USB handle for readback; reopening native CDC can
        # trigger another host-side reset on some macOS USB controller paths.
        try:
            configuration = read_configuration_from(device, actual, seconds=6)
        except (ValueError, OSError) as exc:
            error = str(exc)
    for _ in range(2 if configuration is None else 0):
        time.sleep(1)
        candidate = next((p for p in inventory() if p['deviceId'] == actual), None)
        if not candidate:
            continue
        try:
            configuration = read_configuration(candidate['path'], actual, seconds=4)
            break
        except (ValueError, OSError) as exc:
            error = str(exc)
    if configuration and (configuration.get('firmware') != manifest['version'] or configuration.get('hardware') != manifest['hardware']):
        raise ValueError('Flash written, but application version readback did not match the release.')
    return {'flashVerified': True, 'runningVerified': bool(configuration), 'deviceId': actual,
            'configuration': configuration, 'detail': 'Firmware installed and running.' if configuration else
            'Flash hashes verified. Release BOOT, press RESET, then read the version to confirm startup.', 'readbackError': error}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['ports', 'read', 'flash'])
    parser.add_argument('--port'); parser.add_argument('--release'); parser.add_argument('--device', default='')
    args = parser.parse_args()
    try:
        if args.action == 'ports':
            result = {'ports': inventory()}
        elif args.action == 'read':
            result = {'configuration': read_configuration(args.port, args.device)}
        else:
            result = flash(args.port, args.release, args.device)
        print('PAL_RESULT ' + json.dumps(result), flush=True)
    except Exception as error:
        print('PAL_ERROR ' + str(error), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
