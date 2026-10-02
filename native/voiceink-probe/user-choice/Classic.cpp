/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/
 * Adapted from mozilla/gecko-dev browser/components/shell/WindowsUserChoice.cpp.
 * Standalone native adapter; only reads registry and computes a hash. */
#include "HashCommon.h"
static DWORD Swap(DWORD v) {return (v >> 16) | (v << 16);}
bool ClassicHashFor(const std::wstring &ext, const std::wstring &prog, std::wstring *result) {
    HANDLE token; if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return false;
    DWORD size=0;GetTokenInformation(token,TokenUser,nullptr,0,&size);std::vector<BYTE> user(size);
    const bool got=GetTokenInformation(token,TokenUser,user.data(),size,&size)!=0;CloseHandle(token);if(!got)return false;
    wchar_t *text=nullptr;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER *>(user.data())->User.Sid,&text))return false;
    const std::wstring sid=text;LocalFree(text);
    SYSTEMTIME st;GetSystemTime(&st);st.wSecond=0;st.wMilliseconds=0;FILETIME time;
    if(!SystemTimeToFileTime(&st,&time))return false;
    wchar_t stamp[17]; swprintf(stamp,17,L"%08lx%08lx",time.dwHighDateTime,time.dwLowDateTime);
    auto input = UserChoiceLatestHash::ToLowerWide(ext + sid + prog + stamp + L"User Choice set via Windows User Experience {D18B6DD5-6124-4341-9318-804003BAFA0B}");
    const auto bytes = reinterpret_cast<const BYTE *>(input.c_str()); const DWORD length = static_cast<DWORD>((input.size()+1)*2);
    HCRYPTPROV provider=0;HCRYPTHASH md=0;DWORD digest[4]={},digestSize=sizeof(digest);
    if(!CryptAcquireContextW(&provider,nullptr,nullptr,PROV_RSA_FULL,CRYPT_VERIFYCONTEXT))return false;
    const bool hashed=CryptCreateHash(provider,CALG_MD5,0,0,&md) && CryptHashData(md,bytes,length,0) && CryptGetHashParam(md,HP_HASHVAL,reinterpret_cast<BYTE *>(digest),&digestSize,0);
    if(md)CryptDestroyHash(md);CryptReleaseContext(provider,0);if(!hashed)return false;
    const DWORD c0[2][5]={{digest[0]|1,0xCF98B111,0x87085B9F,0x12CEB96D,0x257E1D83},{digest[1]|1,0xA27416F5,0xD38396FF,0x7C932B89,0xBFA49F69}};
    const DWORD c1[2][5]={{digest[0]|1,0xEF0569FB,0x689B6B9F,0x79F8A395,0xC3EFEA97},{digest[1]|1,0xC31713DB,0xDDCD1F0F,0x59C3AF2D,0x35BD1EC9}};
    DWORD h0=0,h1=0,a0=0,a1=0;
    for(DWORD i=0;i<length/8;++i)for(DWORD j=0;j<2;++j){
        DWORD word;memcpy(&word,bytes+(i*2+j)*4,4);h0+=word;h0*=c0[j][0];
        for(int k=1;k<5;++k)h0=Swap(h0)*c0[j][k];a0+=h0;
        h1+=word;h1=Swap(h1)*c1[j][1]+h1*c1[j][0];h1=(h1>>16)*c1[j][2]+h1*c1[j][3];h1=Swap(h1)*c1[j][4]+h1;a1+=h1;
    }
    DWORD hash[2]={h0^h1,a0^a1}; wchar_t out[32];DWORD count=32;
    if(!CryptBinaryToStringW(reinterpret_cast<BYTE *>(hash),sizeof(hash),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,out,&count))return false;
    *result=out;return true;
}
