"use client";

import { Search } from 'lucide-react';
import React from 'react';
import { Input } from '../ui/input';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
// Internship Feature 4 (phase 1) - localized right-rail strings.
import { useLanguage } from '@/context/LanguageContext';




const suggestions = [
  {
    id: '1',
    username: 'narendramodi',
    displayName: 'Narendra Modi',
    avatar: 'https://images.pexels.com/photos/1043471/pexels-photo-1043471.jpeg?auto=compress&cs=tinysrgb&w=400',
    verified: true
  },
  {
    id: '2',
    username: 'akshaykumar',
    displayName: 'Akshay Kumar',
    // Internship Feature 1 (phase 4) - the previous photo id
    // (photos/1382735) was deleted upstream and returned a persistent 404 in
    // the browser console. Replaced with a portrait URL verified to return
    // HTTP 200. If this URL ever dies too, Radix <AvatarImage> automatically
    // falls back to the <AvatarFallback> initial below - the UI never breaks.
    avatar: 'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=400',
    verified: true
  },
  {
    id: '3',
    username: 'rashtrapatibhvn',
    displayName: 'President of India',
    avatar: 'https://images.pexels.com/photos/1080213/pexels-photo-1080213.jpeg?auto=compress&cs=tinysrgb&w=400',
    verified: true
  }
];

export default function RightSidebar({ onSubscribe }: { onSubscribe?: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="w-80 p-4 space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
        <Input
          placeholder={t('sidebar.search')}
          className="pl-12 bg-gray-900 border-gray-800 text-white placeholder-gray-400 rounded-full py-3"
        />
      </div>

      {/* Subscribe to Premium */}
      <Card className="bg-gray-900 border-gray-800">
        <CardContent className="p-4">
          <h3 className="text-white text-xl font-bold mb-2">{t('sidebar.subscribeTitle')}</h3>
          <p className="text-gray-400 text-sm mb-4">
            {t('sidebar.subscribeBody')}
          </p>
          {/* Internship Feature 1 (phase 4) - this button previously had NO
              onClick, so clicking "Subscribe" did literally nothing. It now
              navigates to the Subscription page through the same
              `currentPage` state Mainlayout already uses. */}
          <Button
            className="bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-full"
            onClick={onSubscribe}
          >
            {t('sidebar.subscribeButton')}
          </Button>
        </CardContent>
      </Card>

     

      {/* Who to follow */}
      <Card className="bg-gray-900 border-gray-800">
        <CardContent className="p-4">
          <h3 className="text-white text-xl font-bold mb-4">{t('sidebar.youMightLike')}</h3>
          <div className="space-y-4">
            {suggestions.map((user) => (
              <div key={user.id} className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <Avatar className="h-10 w-10">
                    <AvatarImage src={user.avatar} alt={user.displayName} />
                    <AvatarFallback>{user.displayName[0]}</AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center space-x-1">
                      <span className="text-white font-semibold">{user.displayName}</span>
                      {user.verified && (
                        <div className="bg-blue-500 rounded-full p-0.5">
                          <svg className="h-3 w-3 text-white fill-current" viewBox="0 0 20 20">
                            <path d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <span className="text-gray-400 text-sm">@{user.username}</span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="bg-white text-black hover:bg-gray-200 font-semibold rounded-full px-4"
                >
                  {t('sidebar.follow')}
                </Button>
              </div>
            ))}
          </div>
          <Button variant="ghost" className="text-blue-400 hover:text-blue-300 p-0 mt-4">
            {t('sidebar.showMore')}
          </Button>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="p-4 text-xs text-gray-500 space-y-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <a href="#" className="hover:underline">{t('sidebar.terms')}</a>
          <a href="#" className="hover:underline">{t('sidebar.privacy')}</a>
          <a href="#" className="hover:underline">{t('sidebar.cookies')}</a>
          <a href="#" className="hover:underline">{t('sidebar.accessibility')}</a>
          <a href="#" className="hover:underline">{t('sidebar.ads')}</a>
        </div>
        <div>{t('sidebar.copyright')}</div>
      </div>
    </div>
  );
}