Models are operator-supplied and excluded from Git. No automatic weight downloads.

- Windows CPU test: `yolov8n.pt` (COCO classes car=2, motorcycle=3, bus=5, truck=7).
- Orange Pi: `yolov8n.rknn`, RK3588, INT8, RGB 640×640, Rockchip model-zoo YOLOv8 DFL outputs (6/9 NCHW tensors).
- A one-output Ultralytics RKNN export is incompatible with this worker's model-zoo postprocessor.
- Generic detection does not recognize license plates, vehicle ownership, dock occupancy or traffic rules.

Convert on a supported x86 Linux environment using the exact toolchain/runtime version approved for the board:
https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolov8/README.md
Use representative calibration images from the actual four cameras; store model hash, toolkit version,
calibration dataset and validation results alongside the deployed model.
