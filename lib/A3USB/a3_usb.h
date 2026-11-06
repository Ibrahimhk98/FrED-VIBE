#pragma once
#include <driver/usb_serial_jtag.h>

#ifdef __cplusplus
extern "C" {
#endif
esp_err_t a3_usb_driver_install(usb_serial_jtag_driver_config_t *config);
esp_err_t a3_usb_driver_uninstall(void);
int a3_usb_read_bytes(void *buffer, uint32_t length, TickType_t timeout);
int a3_usb_write_bytes(const void *buffer, size_t length, TickType_t timeout);
#ifdef __cplusplus
}
#endif
