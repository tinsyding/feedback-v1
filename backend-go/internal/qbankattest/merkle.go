package qbankattest

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// MerkleProofStep represents one sibling node in an RFC 6962 Merkle audit path.
// Position is "left" when the sibling sits to the left of the running hash, or
// "right" when the sibling sits to the right.
type MerkleProofStep struct {
	Position string `json:"position"`
	Hash     string `json:"hash"`
}

// LeafHash computes the RFC 6962 domain-separated leaf hash:
// SHA-256(0x00 || entryHashBytes).
func LeafHash(entryHashHex string) ([]byte, error) {
	raw, err := decodeSHA256Hex(entryHashHex)
	if err != nil {
		return nil, fmt.Errorf("invalid entry hash: %w", err)
	}
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(raw)
	return h.Sum(nil), nil
}

// NodeHash computes the RFC 6962 domain-separated interior node hash:
// SHA-256(0x01 || left || right).
func NodeHash(left, right []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(left)
	h.Write(right)
	return h.Sum(nil)
}

func decodeSHA256Hex(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return nil, err
	}
	if len(b) != sha256.Size {
		return nil, fmt.Errorf("expected %d bytes, got %d", sha256.Size, len(b))
	}
	return b, nil
}

// ComputeMerkleTree builds a binary SHA-256 Merkle tree (RFC 6962 domain
// separation) over ordered entry_hash hex strings. When a level has an odd
// number of nodes, the trailing node is promoted directly to the next level
// without duplicating it (matching RFC 6962 / Bitcoin-free standard promotion,
// or if we pair it cleanly; promotion without duplication avoids second-preimage
// ambiguity). It returns the hex-encoded Merkle root and an audit proof for
// each leaf index.
func ComputeMerkleTree(entryHashes []string) (string, [][]MerkleProofStep, error) {
	if len(entryHashes) == 0 {
		return "", nil, errors.New("cannot compute merkle tree for empty slice")
	}

	leaves := make([][]byte, len(entryHashes))
	for i, eh := range entryHashes {
		lh, err := LeafHash(eh)
		if err != nil {
			return "", nil, fmt.Errorf("leaf %d: %w", i, err)
		}
		leaves[i] = lh
	}

	proofs := make([][]MerkleProofStep, len(leaves))
	for i := range proofs {
		proofs[i] = []MerkleProofStep{}
	}

	// Track which original leaf indices belong to each node at the current level.
	type levelNode struct {
		hash    []byte
		members []int
	}
	level := make([]levelNode, len(leaves))
	for i, lh := range leaves {
		level[i] = levelNode{hash: lh, members: []int{i}}
	}

	for len(level) > 1 {
		next := make([]levelNode, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			if i+1 == len(level) {
				// Odd trailing node: promote to next level without sibling step.
				next = append(next, level[i])
				continue
			}
			left := level[i]
			right := level[i+1]
			rightHex := hex.EncodeToString(right.hash)
			leftHex := hex.EncodeToString(left.hash)
			for _, idx := range left.members {
				proofs[idx] = append(proofs[idx], MerkleProofStep{
					Position: "right",
					Hash:     rightHex,
				})
			}
			for _, idx := range right.members {
				proofs[idx] = append(proofs[idx], MerkleProofStep{
					Position: "left",
					Hash:     leftHex,
				})
			}
			mergedMembers := make([]int, 0, len(left.members)+len(right.members))
			mergedMembers = append(mergedMembers, left.members...)
			mergedMembers = append(mergedMembers, right.members...)
			next = append(next, levelNode{
				hash:    NodeHash(left.hash, right.hash),
				members: mergedMembers,
			})
		}
		level = next
	}

	return hex.EncodeToString(level[0].hash), proofs, nil
}

// VerifyMerkleProof verifies that entryHashHex belongs to merkleRootHex using
// the provided audit path.
func VerifyMerkleProof(entryHashHex, merkleRootHex string, proof []MerkleProofStep) bool {
	cur, err := LeafHash(entryHashHex)
	if err != nil {
		return false
	}
	expectedRoot, err := decodeSHA256Hex(merkleRootHex)
	if err != nil {
		return false
	}
	for _, step := range proof {
		sib, err := decodeSHA256Hex(step.Hash)
		if err != nil {
			return false
		}
		switch step.Position {
		case "left":
			cur = NodeHash(sib, cur)
		case "right":
			cur = NodeHash(cur, sib)
		default:
			return false
		}
	}
	return hex.EncodeToString(cur) == hex.EncodeToString(expectedRoot)
}
