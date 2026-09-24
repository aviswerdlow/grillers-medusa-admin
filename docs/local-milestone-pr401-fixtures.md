# PR #401 fixture coverage for #367

The source fixture set is strategy PR #401, `F367-01` through `F367-20`.
All cases below are synthetic source tests. They do not prove a real staff
walkthrough, provider send, private bucket, production migration, or release
approval. Backend events are in admin PR #59, the in-memory evidence contract
is in admin PR #62, notices are in this PR, and the phone page is in frontend
PR #97.

| Fixture | Source verification | Status |
| --- | --- | --- |
| F367-01 | PR #59 pickup transaction; this PR notice claim transaction | Covered in source |
| F367-02 | PR #59 pickup collection transaction | Covered in source |
| F367-03 | PR #59 southeast route promise transaction | Covered in source |
| F367-04 | PR #59 assigned driver departure transaction | Covered in source |
| F367-05 | PR #62 private evidence interface only | Pending private storage |
| F367-06 | PR #59 failed-delivery queue; this PR office alert transaction | Covered in source |
| F367-07 | PR #59 payment-hold transaction | Covered in source |
| F367-08 | PR #59 unassigned driver rejection | Covered in source |
| F367-09 | PR #59 concurrent event retry; this PR one notice claim | Covered in source |
| F367-10 | PR #59 out-of-order delivery transaction | Covered in source |
| F367-11 | PR #62 invalid type/size/bytes in-memory test | Pending private storage |
| F367-12 | PR #62 interrupted upload and retry in-memory test | Pending private storage |
| F367-13 | No-photo exception requires Peter's #359 policy and private evidence workflow | Pending private storage and policy |
| F367-14 | PR #59 provider service principal cannot record milestone | Covered in source |
| F367-15 | PR #59 carrier service principal cannot record milestone | Covered in source |
| F367-16 | This PR accepted-order email snapshot and policy hold tests | Covered in source |
| F367-17 | This PR UPS-only order-SMS consent suppression test | Covered in source; local SMS held |
| F367-18 | This PR uncertain provider attempt and no replay test | Covered in source |
| F367-19 | PR #62 public/unauthorized/expired read in-memory test | Pending private storage |
| F367-20 | PR #59 correction history; this PR office alert test | Covered in source |

The five photo-dependent cases remain pending production verification until
Avi records the private bucket/provider go on #367. The real-device rehearsal
in #332 and Peter's notice/action answers in #359 remain separate gates.
