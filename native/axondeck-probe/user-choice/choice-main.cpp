#include "HashCommon.h"
bool ClassicHashFor(const std::wstring &, const std::wstring &, std::wstring *);
// Hash-only helper: no registry writes, no GUI, no identity in output.
int wmain(int argc, wchar_t **argv) {
    if ((argc != 3 && argc != 4) || (wcscmp(argv[1], L"--hash") && wcscmp(argv[1], L"--verify") && wcscmp(argv[1], L"--classic-for"))) return 1;
    const std::wstring ext = argv[2];
    if (ext.size() < 2 || ext.size() > 16 || ext[0] != L'.') return 1;
    for (size_t i = 1; i < ext.size(); ++i) if (!iswalnum(ext[i])) return 1;
    if (!wcscmp(argv[1], L"--classic-for")) {
        if (argc != 4) return 1; const std::wstring prog=argv[3];
        if(prog.empty() || prog.size()>255)return 1;
        for(wchar_t c:prog)if(!iswalnum(c) && c!=L'.' && c!=L'_' && c!=L'-')return 1;
        std::wstring hash; if(!ClassicHashFor(ext,prog,&hash))return 2;
        std::wcout << hash << L"\n";return 0;
    }
    if(argc != 3)return 1;
    UserChoiceLatestHash::WorkingSeeds seeds;
    UserChoiceLatestHash::LoadProvidedSeeds(&seeds);
    UserChoiceLatestHash::AssocContext context;
    if (!UserChoiceLatestHash::VerifyCurrentAssociation(ext, seeds, &context)) return 2;
    if (!wcscmp(argv[1], L"--verify")) return context.registry_hash == context.computed_primary ? 0 : 3;
    std::wcout << context.computed_primary << L"\n";
    return 0;
}
