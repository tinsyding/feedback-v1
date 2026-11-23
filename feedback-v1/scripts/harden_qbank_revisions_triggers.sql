-- ============================================================
-- harden_qbank_revisions_triggers.sql
-- 可选触发器硬化脚本（Append-Only 只增不改不删防篡改保护）
-- 说明：均采用单语句触发器写法，可直接由客户端逐条执行；
--       在确认 011_qbank_attestation_tables.sql 已应用后，由 DBA 按需手工执行。
-- ============================================================

DROP TRIGGER IF EXISTS `trg_qbank_revisions_no_update`;
CREATE TRIGGER `trg_qbank_revisions_no_update`
BEFORE UPDATE ON `qbank_revisions`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qbank_revisions is append-only: UPDATE is forbidden';

DROP TRIGGER IF EXISTS `trg_qbank_revisions_no_delete`;
CREATE TRIGGER `trg_qbank_revisions_no_delete`
BEFORE DELETE ON `qbank_revisions`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qbank_revisions is append-only: DELETE is forbidden';

DROP TRIGGER IF EXISTS `trg_qbank_attestation_keys_no_update`;
CREATE TRIGGER `trg_qbank_attestation_keys_no_update`
BEFORE UPDATE ON `qbank_attestation_keys`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qbank_attestation_keys is append-only: UPDATE is forbidden';

DROP TRIGGER IF EXISTS `trg_qbank_attestation_keys_no_delete`;
CREATE TRIGGER `trg_qbank_attestation_keys_no_delete`
BEFORE DELETE ON `qbank_attestation_keys`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qbank_attestation_keys is append-only: DELETE is forbidden';

DROP TRIGGER IF EXISTS `trg_qbank_attestation_anchors_no_update`;
CREATE TRIGGER `trg_qbank_attestation_anchors_no_update`
BEFORE UPDATE ON `qbank_attestation_anchors`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qbank_attestation_anchors is append-only: UPDATE is forbidden';

DROP TRIGGER IF EXISTS `trg_qbank_attestation_anchors_no_delete`;
CREATE TRIGGER `trg_qbank_attestation_anchors_no_delete`
BEFORE DELETE ON `qbank_attestation_anchors`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qbank_attestation_anchors is append-only: DELETE is forbidden';
