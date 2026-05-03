/// Master mix stage: two audiomixer elements (main + cue), master volume,
/// and a tee off the main mix that the recording sink attaches to.
///
/// Topology:
///   [deck pads] → main audiomixer → volume (master) → tee
///                                                        ├─ pipewiresink [main device]
///                                                        └─ [record tap, inactive by default]
///   [deck pads] → cue audiomixer  → pipewiresink [cue device]
///
/// Step 1 / stub: struct and method signatures only.

use gstreamer::{self as gst, prelude::*};

pub struct MasterMix {
    // GStreamer elements will be held here once wired in step 2.
    _main_pipeline: Option<gst::Pipeline>,
    _cue_pipeline: Option<gst::Pipeline>,
    main_device: String,
    cue_device: String,
    master_volume: f32,
}

impl MasterMix {
    pub fn new() -> Self {
        Self {
            _main_pipeline: None,
            _cue_pipeline: None,
            main_device: String::new(),
            cue_device: String::new(),
            master_volume: 1.0,
        }
    }

    /// Set the PipeWire sink node ID/name for the main output.
    pub fn set_main_device(&mut self, device_id: &str) -> Result<(), String> {
        self.main_device = device_id.to_string();
        // Step 4: reconfigure pipewiresink target-object.
        Ok(())
    }

    /// Set the PipeWire sink node ID/name for the headphone cue output.
    pub fn set_cue_device(&mut self, device_id: &str) -> Result<(), String> {
        self.cue_device = device_id.to_string();
        Ok(())
    }

    pub fn set_master_volume(&mut self, volume: f32) -> Result<(), String> {
        self.master_volume = volume.clamp(0.0, 1.0);
        // Step 2: apply to GStreamer volume element.
        Ok(())
    }

    pub fn set_cue_gain(&self, _gain: f32) -> Result<(), String> {
        Ok(())
    }
}

impl Drop for MasterMix {
    fn drop(&mut self) {
        if let Some(p) = &self._main_pipeline {
            let _ = p.set_state(gst::State::Null);
        }
        if let Some(p) = &self._cue_pipeline {
            let _ = p.set_state(gst::State::Null);
        }
    }
}
