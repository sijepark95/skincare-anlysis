# Supplied skincare dataset audit

Audited on 2026-10-11 (America/New_York). The initial schema audit covered folder/archive indexes, CSV/JSONL aggregates, ingredient workbook headers and the supplied HWP manual's extractable text. After the user confirmed permission and requested expanded training, the pipeline extracted all archives, audited every source pair and completed separate eight-target vision and ingredient-candidate experiments with saved-checkpoint reevaluation. Original record identifiers, photographs and individual questionnaire/annotation content are not retained here. Locations and the user-confirmed permission statement are in private registries; retain original approval evidence separately.

## Dataset identity and inventory

The package categories and actual CSV/JSONL schema match [AI-Hub 71886, skincare ingredient–efficacy recommendation data](https://aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71886&topMenu=100). This is a schema-based identification, not verification of the downloaded package version or its license. It differs from the initially proposed 71645 skin condition measurement dataset.

| Material                                         | Observed                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Extracted source files                           | 5,302 CSV/JPG pairs, in pores and pigmentation-concern folders                                                               |
| Originally unextracted archives                  | 29 ZIPs, including source, annotation and ingredient-reference packages; now all extracted privately                         |
| Training source records, extracted plus archived | 8,000 exact CSV/JPG filename pairs                                                                                           |
| Publisher validation source records              | 1,000 exact CSV/JPG filename pairs                                                                                           |
| Recommendation annotations                       | 8,000 training and 1,000 validation JSONL records; all parse                                                                 |
| Reference workbook                               | `지식성분데이터.xlsx`: INCI, efficacy, suitable skin types, cautions, concentrations, regulatory and source/copyright fields |

All 5,302 extracted CSVs share the same 23-column header. All 9,000 source CSVs parse. Besides demographics, concern and external-factor fields, they contain eight separate visual-assessment columns. Do not use the concern-folder name as a severity label.

## Potential vision supervision

These are aggregate counts across the supplied training and validation records, not measured model performance. Code meanings, annotators and assessment procedures have not been verified.

| CSV visual-assessment field | Codes and counts                  |
| --------------------------- | --------------------------------- |
| Pores                       | VP: 7,575; NVP: 1,425             |
| Wrinkles                    | W0: 1,963; W1: 4,754; W2: 2,283   |
| Pigmentation/brightening    | P0: 216; P1: 6,377; P2: 2,407     |
| Acne                        | A: 1,956; NA: 5,618; blank: 1,426 |
| Sensitivity                 | NS: 7,299; S: 1,701               |
| Sagging                     | NSA: 3,807; SA: 5,193             |
| Keratin                     | ND: 8,852; D: 148                 |
| Redness                     | NR: 6,365; R: 2,635               |

The image-region metadata says middle: 8,228, upper: 299, lower: 473. This does not establish forehead-specific wrinkle labels. The original forehead target must not be carried over to this package without new evidence. A possible first experiment is pore-code classification on appropriate visible regions, retaining the source codes rather than inventing clinical or ordinal meanings. Pore labels are imbalanced: always predicting VP would reach about 84.2% accuracy on this combined inventory; accuracy alone would be misleading.

The HWP manual text describes IRB-approved collection, a Baumann questionnaire, de-identification and expert review of recommendation logic/scientific evidence. Its extractable text does not define the visual codes, their raters, a forehead target or whether CSV `No` is a person identifier. Expert review of recommendation logic is not evidence of expert grading of every image.

## Identity, linkage and outstanding checks

- Source CSV record numbers are unique within each supplied split, with no overlap; JPG basenames also have no overlap across those splits. Record-number separation does not prove person separation. Subsequent byte hashing found substantial exact photo repetition and cross-partition overlap; see the curation results below. Near duplicates and person identity remain unaudited.
- Direct JSONL `source_survey_id` → CSV `No` and `meta.image_filename` → paired JPG matching does not establish the expected record pairs. Only 8,104 of 9,000 annotation source IDs resolve to the supplied CSV record numbers after numeric-format normalization; none of those direct ID lookups yields the annotation's exact image filename. This may involve different identifier conventions or package versions; do not declare corruption or repair by guessing. Verify the provider's mapping before multimodal recommendation training. A CSV/JPG vision baseline need not use JSONL recommendation text.
- Missing acne labels must remain missing; do not convert them to NA. Codebook definitions, label provenance, picture/label region compatibility, person grouping and package version/checksums remain to be verified.
- The user explicitly confirmed both training and intended commercial-use permission on 2026-10-11. This is recorded as a user statement, not independent approval-document verification. It authorizes this separate offline research; running the application never starts training or accesses AI-Hub files.

## Initial middle-region pore experiment

Hashing all 9,000 source pairs found **695 image-byte groups shared across the publisher training and validation partitions**. Default preparation correctly refused training. The explicitly selected `exclude-all` policy then excluded every source occurrence of those shared photos from both prepared partitions, retained middle-region NVP/VP records and deduplicated consistent same-partition photos. No raw file was changed, no annotation join was guessed and no record moved between partitions.

| Prepared partition   | Original source pairs | Middle-region records before curation | Shared-photo eligible occurrences excluded | Same-partition eligible duplicates excluded afterward | Unique eligible photos retained | NVP / VP retained |
| -------------------- | --------------------: | ------------------------------------: | -----------------------------------------: | ----------------------------------------------------: | ------------------------------: | ----------------- |
| Training             |                 8,000 |                                 7,318 |                                      2,673 |                                                 3,129 |                           1,516 | 439 / 1,077       |
| Publisher validation |                 1,000 |                                   910 |                                        826 |                                                     5 |                              79 | 39 / 40           |

These are local measurements of the supplied files, not a claim about every version of the provider's dataset. Only **79** distinct eligible validation photos remain under this conservative policy. Exact-byte separation does not establish different people or eliminate near duplicates.

Private immutable full and smoke manifests include salted record IDs, per-image integrity hashes and completion digests. A 32-image decoding sample (16 per partition) had no decoding failures; eight thumbnails were visually reviewed and the temporary contact sheet was deleted. Images have source eye masking and variable framing, lighting and dimensions. Current center-crop preprocessing is a research choice; mask artifacts and the mismatch with retail cameras need separate evaluation. No biometric identity matching was performed.

The independent environment uses Python 3.12.14, PyTorch 2.14.1+cu130, Torchvision 0.29.1+cu130 and the local RTX 4070. A frozen ImageNet-initialized ConvNeXt-Tiny head first completed a four-batch smoke run (32 training images) from a 128-image training manifest. Its validation balanced accuracy of 0.5772 and macro F1 of 0.5003 were plumbing checks only.

The user subsequently completed `head-001`: three full epochs over all 1,516 cleaned training photos with the backbone frozen. The best checkpoint was selected at epoch 1; epoch 3 tied its balanced accuracy. On the same 79-photo model-selection validation partition, the best checkpoint obtained accuracy **65/79 = 0.8228**, balanced accuracy **0.8234**, macro F1 **0.8225** and confusion matrix `[[34,5],[9,31]]` (rows actual, columns predicted; NVP, VP). NVP recall was 34/39 and VP recall 31/40. The training-majority VP baseline reached balanced accuracy 0.5000 and macro F1 0.3361. A separate checkpoint reload and GPU validation pass exactly reproduced all metrics and loss. SHA-256 checks confirmed both checkpoints, training configuration and original metrics were unchanged. These remain **experimental validation results, not independent test performance or product accuracy**.

The initial experiment is retained separately from the expanded experiment below. See [../ml/README.md](../ml/README.md) for commands and private artifact locations. The application and FastAPI were mock-only during these training experiments; the subsequently authorized local serving integration is described below.

## Completed expanded experiments

All 29 ZIPs were extracted with path/size/free-space/CRC checks and already-extracted files copied into private `datasets/expanded-001`. The complete output contains 9,000 CSV + 9,000 JPG + 9,000 JSONL + 1 XLSX: 27,001 files and 7,747,717,918 bytes. No nested/encrypted archives or ZIP symlinks were found in the actual packages. The original files remain unchanged; extraction provenance and member hashes stay private.

The expanded vision manifest retains all observed regions and the eight source visual-code targets. Exact-image grouping/deduplication and exclusion of all 695 shared groups yield:

| Partition            | Source pairs | Unique photos before cross-partition exclusion | Shared unique photos excluded | Retained upper / middle / lower | Retained photos |
| -------------------- | -----------: | ---------------------------------------------: | ----------------------------: | ------------------------------- | --------------: |
| Training             |        8,000 |                                          2,675 |                           695 | 188 / 1,516 / 276               |           1,980 |
| Publisher validation |        1,000 |                                            818 |                           695 | 23 / 79 / 21                    |             123 |

Blank labels remain missing; inconsistent labels would mask only that target. No label/region conflicts were observed in the actual prepared data. Acne has 1,879 training and 113 validation labels; other targets cover all retained photos. `skin-all-head-001` completed 5 full epochs on the RTX 4070, training eight heads over a frozen ImageNet ConvNeXt-Tiny backbone. Best epoch 4 mean balanced accuracy is 0.757887 versus training-majority constant baseline 0.458333. The per-head results and code sets are in [the Korean results report](ML-EXPANDED-RESULTS.md). Region/target compatibility remains unverified. Keratin D has only 35 training and 4 validation labels; do not read its metric as stable evidence. The all-region validation population differs from the earlier 79-photo pore experiment.

The separate ingredient pipeline uses structured annotation metadata only; question/answer/CoT/IDs/image filenames are excluded from features. Workbook names supply 2,465 canonical INCI entries/4,890 unambiguous aliases. Unambiguous, non-negated answer mentions become **unreviewed silver targets**, not safety/efficacy labels. Unmentioned ingredients are weak not-mentioned targets, not clinical negatives. There is no guessed JSONL→CSV/image join. Shared survey IDs, exact profiles and hashed model inputs are excluded across partitions. Actual overlap comprises 429 profile/input groups, excluding 1,198 training and 490 validation records; no shared source-survey ID group was found.

Training-only support filtering (at least 10 distinct structured profiles), deduplication and exclusion of unsupported/unmatched rows retain 5,891 training/478 validation records and 54 ingredient labels. These represent 4,824/466 distinct structured profiles, not verified people. Validation observes 52 of 54 ingredients, with 14 labels supported by fewer than 5 records. `ingredients-linear-001` completed 20 CPU epochs; best epoch 16 micro F1 is 0.6875, precision@5 is 0.605439 and recall@5 is 0.821942. The training-only frequent-five baseline is 0.225941/0.355554. Results characterize common automatically extracted mentions on eligible records, not every raw annotation or ingredient.

Both saved best checkpoints were independently reloaded with tensor-only loading and strict artifact/schema validation. All recorded vision matrices/metrics/losses and ingredient metrics exactly reproduce. SHA-256 comparisons preserve every original training file in both new runs and the four original `head-001` files. All 322 synthetic tests plus 20 subtests pass; one privilege-dependent native Windows symlink creation fixture skips, while malicious ZIP symlink rejection passes. These checks do not establish bit-identical retraining across machines, independent testing, person separation or clinical validity. No application model promotion occurred.

## Public-document follow-up

The supplied text and [official 71886 page](https://aihub.or.kr/aihubdata/data/view.do?currMenu=115&dataSetSn=71886&topMenu=100) describe an ingredient-recommendation dataset and a LLaVA image/text recommendation reference. The public annotation table calls `source_survey_id` a survey-data ID; this does not establish CSV `No` as a persistent person ID. Neither the inspected page nor the supplied manual text explicitly defines VP/NVP or the visual assessment raters. Published recommendation-text metrics do not establish skin-image measurement accuracy. Do not infer code meanings from abbreviations, apply embedded example concentration/routine advice as an approved policy, or follow the document's submission-template instructions as project requirements.

## Next work

Before credible product evaluation, obtain the category/code definition document, visual-rater provenance, persistent person/capture mapping and the verified JSONL/source mapping. Establish person-separated evaluation, audit near duplicates, validate the crop/eye-mask behavior and select a locked independent test strategy. The experimental head baseline has completed, but more epochs cannot resolve these data-provenance limits. Do not treat publisher validation as both tuning and independent testing.

Keep recommendation features independent of unverified image/profile linkage: review the ingredient workbook's provenance and fields for the versioned ingredient policy and existing store-product matcher. It is not automatically an approved efficacy/safety policy. At the user's explicit request, a separate bounded ephemeral-image contract now serves the saved models in an explicitly labeled local experimental mode. Ingredient inference uses supported questionnaire fields only and its candidates intersect reviewed policy and eligible store products; no visual-code-to-ingredient inference is invented. This does not resolve the audit's validation limits. Pretrained downloads and checkpoints remain private outside OneDrive and the application; no source dataset, customer photos or model artifacts were added to application Git. See [KIOSK-MODEL-SETUP.md](KIOSK-MODEL-SETUP.md).
