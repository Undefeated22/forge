use napi::bindgen_prelude::*;
use napi_derive::napi;
use tfhe::prelude::*;
use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2;
use tfhe::{set_server_key, ClientKey, CompressedServerKey, ConfigBuilder, FheBool, FheUint16};

fn ser<T: serde::Serialize>(v: &T, what: &str) -> Result<Vec<u8>> {
    bincode::serialize(v).map_err(|e| Error::from_reason(format!("{what} serialize: {e}")))
}

fn de<T: serde::de::DeserializeOwned>(bytes: &[u8], what: &str) -> Result<T> {
    bincode::deserialize(bytes).map_err(|e| Error::from_reason(format!("{what} deserialize: {e}")))
}

fn load_server_key(bytes: &[u8]) -> Result<()> {
    let compressed: CompressedServerKey = de(bytes, "compressed server key")?;
    let sk = compressed.decompress();
    set_server_key(sk);
    Ok(())
}

#[napi]
pub fn homomorphic_add(ct_a: Buffer, ct_b: Buffer, server_key: Buffer) -> Result<Buffer> {
    load_server_key(&server_key)?;
    let a: FheUint16 = de(&ct_a, "ciphertext a")?;
    let b: FheUint16 = de(&ct_b, "ciphertext b")?;
    let result = &a + &b;
    Ok(Buffer::from(ser(&result, "result ciphertext")?))
}

#[napi]
pub fn apply_anomaly_threshold(ct: Buffer, server_key: Buffer, threshold: u32) -> Result<Buffer> {
    load_server_key(&server_key)?;
    let value: FheUint16 = de(&ct, "ciphertext")?;
    let flag: FheBool = value.ge(threshold as u16);
    Ok(Buffer::from(ser(&flag, "anomaly flag ciphertext")?))
}

fn scoped_config() -> tfhe::Config {
    ConfigBuilder::with_custom_parameters(PARAM_MESSAGE_2_CARRY_2).build()
}

#[cfg(feature = "insecure-test-keygen")]
mod test_only {
    use super::*;

    #[napi(object)]
    pub struct TestKeyPair {
        pub client_key: Buffer,
        pub server_key: Buffer,
    }

    #[napi]
    pub fn keygen_for_local_testing() -> Result<TestKeyPair> {
        let config = scoped_config();
        let client_key = ClientKey::generate(config);
        let compressed_server_key = CompressedServerKey::new(&client_key);

        Ok(TestKeyPair {
            client_key: Buffer::from(ser(&client_key, "client key")?),
            server_key: Buffer::from(ser(&compressed_server_key, "compressed server key")?),
        })
    }

    #[napi]
    pub fn encrypt_for_testing(value: u32, client_key: Buffer) -> Result<Buffer> {
        let ck: ClientKey = de(&client_key, "client key")?;
        let ct = FheUint16::encrypt(value as u16, &ck);
        Ok(Buffer::from(ser(&ct, "ciphertext")?))
    }

    #[napi]
    pub fn decrypt_for_testing(ct: Buffer, client_key: Buffer) -> Result<u32> {
        let ck: ClientKey = de(&client_key, "client key")?;
        let ct: FheUint16 = de(&ct, "ciphertext")?;
        let val: u16 = ct.decrypt(&ck);
        Ok(val as u32)
    }

    #[napi]
    pub fn decrypt_bool_for_testing(ct: Buffer, client_key: Buffer) -> Result<bool> {
        let ck: ClientKey = de(&client_key, "client key")?;
        let flag: FheBool = de(&ct, "bool ciphertext")?;
        Ok(flag.decrypt(&ck))
    }
}

#[cfg(feature = "insecure-test-keygen")]
pub use test_only::*;
