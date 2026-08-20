use std::{env, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let proto_dir = manifest_dir.join("../betterdesk-server/protos");
    let message = proto_dir.join("message.proto");
    let rendezvous = proto_dir.join("rendezvous.proto");

    println!("cargo:rerun-if-changed={}", message.display());
    println!("cargo:rerun-if-changed={}", rendezvous.display());

    prost_build::Config::new()
        .compile_protos(&[message, rendezvous], &[proto_dir])
        .expect("compile BetterDesk interoperability protobufs");
}
