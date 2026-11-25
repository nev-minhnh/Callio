//! The three-way decision for one path: what we saw last time both sides agreed (the base), what
//! the local side is now and what the remote side is now. Pure and tested; the engine only
//! executes what this says. A conflict is never resolved by overwriting.

#[derive(Clone, Debug, PartialEq)]
pub enum Obs {
    /// no such file
    Absent,
    /// there, and the same bytes as the last synced version
    Same,
    /// there, and different from the base (or there is no base): the content hash
    Changed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    TwoWay,
    UploadOnly,
    DownloadOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    BothChanged,
    BothNew,
    /// deleted here, edited there
    LocalDeleted,
    RemoteDeleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Nothing,
    Upload,
    Download,
    /// local copy goes to the Recycle Bin
    DeleteLocal,
    /// remote copy goes to .callio-trash
    DeleteRemote,
    /// both sides already hold the same bytes: just record it
    Adopt,
    /// gone on both sides: drop the record
    Forget,
    Conflict(Why),
}

pub fn decide(has_base: bool, l: &Obs, r: &Obs, dir: Direction) -> Action {
    use Action::*;
    let a = match (has_base, l, r) {
        (_, Obs::Absent, Obs::Absent) => if has_base { Forget } else { Nothing },
        (false, Obs::Changed(_), Obs::Absent) | (false, Obs::Same, Obs::Absent) => Upload,
        (false, Obs::Absent, Obs::Changed(_)) | (false, Obs::Absent, Obs::Same) => Download,
        (false, Obs::Changed(a), Obs::Changed(b)) => if a == b { Adopt } else { Conflict(Why::BothNew) },
        (false, _, _) => Nothing,
        (true, Obs::Same, Obs::Same) => Nothing,
        (true, Obs::Changed(_), Obs::Same) => Upload,
        (true, Obs::Same, Obs::Changed(_)) => Download,
        (true, Obs::Changed(a), Obs::Changed(b)) => if a == b { Adopt } else { Conflict(Why::BothChanged) },
        (true, Obs::Absent, Obs::Same) => DeleteRemote,
        (true, Obs::Same, Obs::Absent) => DeleteLocal,
        (true, Obs::Absent, Obs::Changed(_)) => Conflict(Why::LocalDeleted),
        (true, Obs::Changed(_), Obs::Absent) => Conflict(Why::RemoteDeleted),
    };
    // one-way links ignore what happens on the side they never write to
    match (dir, a) {
        (Direction::UploadOnly, Download | DeleteLocal) => Nothing,
        (Direction::DownloadOnly, Upload | DeleteRemote) => Nothing,
        (Direction::UploadOnly, Conflict(Why::LocalDeleted)) => Nothing,
        (Direction::DownloadOnly, Conflict(Why::RemoteDeleted)) => Nothing,
        (_, a) => a,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Action::*;
    fn c(h: &str) -> Obs { Obs::Changed(h.into()) }
    #[test]
    fn table() {
        let d = Direction::TwoWay;
        assert_eq!(decide(true, &Obs::Same, &Obs::Same, d), Nothing);
        assert_eq!(decide(true, &c("a"), &Obs::Same, d), Upload);
        assert_eq!(decide(true, &Obs::Same, &c("a"), d), Download);
        assert_eq!(decide(true, &c("a"), &c("a"), d), Adopt);
        assert_eq!(decide(true, &c("a"), &c("b"), d), Conflict(Why::BothChanged));
        assert_eq!(decide(true, &Obs::Absent, &Obs::Same, d), DeleteRemote);
        assert_eq!(decide(true, &Obs::Same, &Obs::Absent, d), DeleteLocal);
        assert_eq!(decide(true, &Obs::Absent, &c("x"), d), Conflict(Why::LocalDeleted));
        assert_eq!(decide(true, &c("x"), &Obs::Absent, d), Conflict(Why::RemoteDeleted));
        assert_eq!(decide(true, &Obs::Absent, &Obs::Absent, d), Forget);
        assert_eq!(decide(false, &c("a"), &Obs::Absent, d), Upload);
        assert_eq!(decide(false, &Obs::Absent, &c("a"), d), Download);
        assert_eq!(decide(false, &c("a"), &c("a"), d), Adopt);
        assert_eq!(decide(false, &c("a"), &c("b"), d), Conflict(Why::BothNew));
    }
    #[test]
    fn one_way() {
        assert_eq!(decide(true, &Obs::Same, &c("a"), Direction::UploadOnly), Nothing);
        assert_eq!(decide(true, &c("a"), &Obs::Same, Direction::UploadOnly), Upload);
        assert_eq!(decide(true, &c("a"), &Obs::Same, Direction::DownloadOnly), Nothing);
        assert_eq!(decide(true, &Obs::Same, &Obs::Absent, Direction::UploadOnly), Nothing);
        assert_eq!(decide(true, &Obs::Absent, &Obs::Same, Direction::UploadOnly), DeleteRemote);
    }
}
