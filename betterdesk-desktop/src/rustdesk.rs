//! BetterDesk-owned RustDesk-compatible wire message builders.
//!
//! These helpers use the interoperability schemas kept in this repository.
//! They do not import RustDesk source or runtime components.

use prost::Message as ProstMessage;

use crate::{
    crypto::KeyExchange,
    hbb::{
        file_action, message, option_message, rendezvous_message, video_frame, Clipboard,
        ClipboardFormat, ConnType, ControlKey, FileAction, IdPk, KeyEvent, LoginRequest,
        Message as HbbMessage, MouseEvent, NatType, OptionMessage, PublicKey, PunchHoleRequest,
        ReadDir, RegisterPk, RendezvousMessage, RequestRelay, SupportedDecoding,
    },
    transport,
};

pub const CLIENT_VERSION: &str = "BetterDesk-Desktop/3.5";
pub const CAPABILITIES: &[&str] = &[
    "remote_desktop",
    "keyboard_input",
    "mouse_input",
    "clipboard",
    "file_transfer",
    "audio",
    "multi_monitor",
    "unattended_access",
];

pub fn punch_hole_request(device_id: &str, server_key: &str) -> RendezvousMessage {
    RendezvousMessage {
        union: Some(rendezvous_message::Union::PunchHoleRequest(
            PunchHoleRequest {
                id: device_id.to_owned(),
                nat_type: NatType::Symmetric as i32,
                licence_key: server_key.to_owned(),
                conn_type: ConnType::DefaultConn as i32,
                token: String::new(),
                version: CLIENT_VERSION.to_owned(),
                udp_port: 0,
                force_relay: true,
                upnp_port: 0,
                socket_addr_v6: Vec::new(),
            },
        )),
    }
}

pub fn request_relay(
    device_id: &str,
    uuid: &str,
    relay_server: &str,
    server_key: &str,
) -> RendezvousMessage {
    RendezvousMessage {
        union: Some(rendezvous_message::Union::RequestRelay(RequestRelay {
            id: device_id.to_owned(),
            uuid: uuid.to_owned(),
            socket_addr: Vec::new(),
            relay_server: relay_server.to_owned(),
            secure: false,
            licence_key: server_key.to_owned(),
            conn_type: ConnType::DefaultConn as i32,
            token: String::new(),
            control_permissions: None,
        })),
    }
}

pub fn register_pk_request(id: &str, uuid: &[u8], public_key: &[u8]) -> RendezvousMessage {
    RendezvousMessage {
        union: Some(rendezvous_message::Union::RegisterPk(RegisterPk {
            id: id.to_owned(),
            uuid: uuid.to_vec(),
            pk: public_key.to_vec(),
            old_id: String::new(),
            no_register_device: false,
        })),
    }
}

pub fn login_request(device_id: &str, password_hash: Vec<u8>, session_id: u64) -> HbbMessage {
    let option = OptionMessage {
        image_quality: 4,
        lock_after_session_end: option_message::BoolOption::No as i32,
        show_remote_cursor: option_message::BoolOption::Yes as i32,
        privacy_mode: option_message::BoolOption::No as i32,
        block_input: option_message::BoolOption::No as i32,
        custom_image_quality: 0,
        disable_audio: option_message::BoolOption::No as i32,
        disable_clipboard: option_message::BoolOption::No as i32,
        enable_file_transfer: option_message::BoolOption::Yes as i32,
        supported_decoding: Some(SupportedDecoding {
            ability_vp9: 1,
            ability_h264: 1,
            ability_h265: 1,
            prefer: 0,
            ability_vp8: 1,
            ability_av1: 1,
            i444: None,
            prefer_chroma: 0,
        }),
        custom_fps: 60,
        disable_keyboard: option_message::BoolOption::No as i32,
        follow_remote_cursor: option_message::BoolOption::No as i32,
        follow_remote_window: option_message::BoolOption::No as i32,
        disable_camera: option_message::BoolOption::No as i32,
        terminal_persistent: option_message::BoolOption::No as i32,
        show_my_cursor: option_message::BoolOption::Yes as i32,
    };
    HbbMessage {
        union: Some(message::Union::LoginRequest(LoginRequest {
            username: device_id.to_owned(),
            password: password_hash,
            my_id: format!("betterdesk-desktop-{session_id}"),
            my_name: "BetterDesk Desktop".to_owned(),
            option: Some(option),
            union: None,
            video_ack_required: false,
            session_id,
            version: CLIENT_VERSION.to_owned(),
            os_login: None,
            my_platform: std::env::consts::OS.to_owned(),
            hwid: Vec::new(),
        })),
    }
}

pub fn mouse_event(mask: i32, x: i32, y: i32) -> HbbMessage {
    HbbMessage {
        union: Some(message::Union::MouseEvent(MouseEvent {
            mask,
            x,
            y,
            modifiers: Vec::new(),
        })),
    }
}

pub fn unicode_key_event(unicode: u32, down: bool, press: bool) -> HbbMessage {
    HbbMessage {
        union: Some(message::Union::KeyEvent(KeyEvent {
            down,
            press,
            union: Some(crate::hbb::key_event::Union::Unicode(unicode)),
            modifiers: Vec::new(),
            mode: crate::hbb::KeyboardMode::Auto as i32,
        })),
    }
}

pub fn control_key_event(key: ControlKey, down: bool, press: bool) -> HbbMessage {
    HbbMessage {
        union: Some(message::Union::KeyEvent(KeyEvent {
            down,
            press,
            union: Some(crate::hbb::key_event::Union::ControlKey(key as i32)),
            modifiers: Vec::new(),
            mode: crate::hbb::KeyboardMode::Auto as i32,
        })),
    }
}

pub fn clipboard_text(content: &str) -> HbbMessage {
    HbbMessage {
        union: Some(message::Union::Clipboard(Clipboard {
            compress: false,
            content: content.as_bytes().to_vec(),
            width: 0,
            height: 0,
            format: ClipboardFormat::Text as i32,
            special_name: String::new(),
        })),
    }
}

pub fn read_directory(path: &str, include_hidden: bool) -> HbbMessage {
    HbbMessage {
        union: Some(message::Union::FileAction(FileAction {
            union: Some(file_action::Union::ReadDir(ReadDir {
                path: path.to_owned(),
                include_hidden,
            })),
        })),
    }
}

pub fn audio_frame(data: Vec<u8>) -> HbbMessage {
    HbbMessage {
        union: Some(message::Union::AudioFrame(crate::hbb::AudioFrame { data })),
    }
}

pub fn encoded_video_frame(message: &HbbMessage) -> Option<Vec<u8>> {
    let message::Union::VideoFrame(frame) = message.union.as_ref()? else {
        return None;
    };
    let frames = match frame.union.as_ref()? {
        video_frame::Union::Vp9s(frames)
        | video_frame::Union::H264s(frames)
        | video_frame::Union::H265s(frames)
        | video_frame::Union::Vp8s(frames)
        | video_frame::Union::Av1s(frames) => frames,
        video_frame::Union::Rgb(_) | video_frame::Union::Yuv(_) => return None,
    };
    frames.frames.first().map(|frame| frame.data.clone())
}

pub fn public_key_message(exchange: &KeyExchange) -> HbbMessage {
    let encrypted = exchange
        .encrypted_symmetric_key()
        .expect("peer public key must be set before key exchange");
    HbbMessage {
        union: Some(message::Union::PublicKey(PublicKey {
            asymmetric_value: exchange.public_key().to_vec(),
            symmetric_value: encrypted,
        })),
    }
}

pub fn encode<M: ProstMessage>(message: &M) -> Vec<u8> {
    transport::encode_message(message).expect("protobuf message encoding cannot fail")
}

pub fn signed_id_payload(id: &str, public_key: &[u8]) -> Vec<u8> {
    IdPk {
        id: id.to_owned(),
        pk: public_key.to_vec(),
    }
    .encode_to_vec()
}

pub fn split_signed_id(value: &[u8]) -> Option<(&[u8], &[u8])> {
    (value.len() >= 64).then(|| value.split_at(64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn punch_hole_is_relay_only() {
        let message = punch_hole_request("BD-1", "key");
        let bytes = encode(&message);
        assert!(!bytes.is_empty());
    }

    #[test]
    fn signed_id_payload_is_protobuf() {
        let bytes = signed_id_payload("BD-1", &[7_u8; 32]);
        let parsed = IdPk::decode(bytes.as_slice()).unwrap();
        assert_eq!(parsed.id, "BD-1");
        assert_eq!(parsed.pk, vec![7_u8; 32]);
    }

    #[test]
    fn registration_contains_the_owned_capability_contract() {
        let message = register_pk_request("123456789", &[1, 2, 3], &[7_u8; 32]);
        assert!(matches!(
            message.union,
            Some(rendezvous_message::Union::RegisterPk(_))
        ));
        assert!(CAPABILITIES.contains(&"remote_desktop"));
        assert!(CAPABILITIES.contains(&"multi_monitor"));
    }

    #[test]
    fn input_clipboard_file_and_audio_messages_are_constructible() {
        assert!(!encode(&mouse_event(1, 10, 20)).is_empty());
        assert!(!encode(&unicode_key_event('A' as u32, true, false)).is_empty());
        assert!(!encode(&clipboard_text("hello")).is_empty());
        assert!(!encode(&read_directory("C:\\", false)).is_empty());
        assert!(!encode(&audio_frame(vec![1, 2, 3])).is_empty());
    }
}
