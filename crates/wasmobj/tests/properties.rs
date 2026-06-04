use wasmobj::{mint, read, save, verify, Tier};
use proptest::prelude::*;

proptest! {
    // For any content within the top tier, save -> read round-trips exactly and the
    // result validates as a wasm module.
    #[test]
    fn roundtrip_any_content(content in proptest::collection::vec(any::<u8>(), 0..65532usize)) {
        let mut obj = mint(Tier::B256, 1);
        save(&mut obj, &content).unwrap();
        prop_assert_eq!(read(&obj).unwrap(), content.clone());
        prop_assert!(verify(&obj).is_ok());
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
            .validate_all(&obj)
            .map_err(|e| TestCaseError::fail(format!("invalid module: {e}")))?;
    }
}
